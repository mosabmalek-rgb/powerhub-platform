import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const vitestCli = path.resolve("node_modules/vitest/vitest.mjs");
const env = { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=12288" };

function run(args, timeoutMs = 5 * 60_000) {
  const result = spawnSync(process.execPath, [vitestCli, ...args], {
    stdio: "inherit",
    env,
    windowsHide: false,
    shell: process.platform === "win32",
    timeout: timeoutMs,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      console.error(`Timed out after ${timeoutMs}ms: ${process.execPath} ${vitestCli} ${args.join(" ")}`);
      process.exit(124);
    }
    throw result.error;
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const vitestArgs = ["run", "--maxWorkers=1", "--minWorkers=1"];
const pageVitestArgs = [...vitestArgs, "--config", "vitest.pages.config.ts"];

function runVitest(paths) {
  run([...vitestArgs, ...paths]);
}

runVitest(["server"]);
runVitest(["client/src/components"]);
runVitest(["client/src/lib", "client/src/contexts", "client/src/hooks"]);

// This pure scheduling test uses the default Vitest configuration, not vitest.pages.config.ts.
runVitest(["client/src/pages/messaging-schedule.test.ts"]);

const pagesDir = "client/src/pages";
if (existsSync(pagesDir)) {
  const roleGuardsPath = "client/src/pages/role-guards.ui.test.tsx";
  if (existsSync(roleGuardsPath)) {
    // Keep each UI test isolated because the page suite contains long-lived
    // browser-side resources. Spawn Vitest directly so a timeout terminates
    // the actual test process instead of leaving a pnpm/Vitest orphan behind.
    const pageTests = [...new Set(Array.from(
      readFileSync(roleGuardsPath, "utf8").matchAll(/^\s*it\(\s*["']([^"']+)["']/gm),
      ([, name]) => name,
    ))];
    for (const name of pageTests) {
      run(pageVitestArgs.concat([roleGuardsPath, "-t", name]), 120_000);
    }
  }
  // Keep the login recovery/diagnostics UI regression suite in the required CI path.
  // It is intentionally separate from the larger page suites for faster, clearer failures.
  for (const entry of ["client/src/pages/LoginPage.ui.test.tsx", "client/src/pages/BillingPage.test.tsx", "client/src/pages/OperationsPage.test.tsx", "client/src/pages/SettingsPage.test.tsx", "client/src/pages/QuickActionsPage.ui.test.tsx", "client/src/pages/WorkspaceHome.smsQuota.ui.test.tsx", "client/src/pages/collection-form-reset.contract.test.ts"]) {
    if (existsSync(entry)) run(pageVitestArgs.concat([entry]));
  }
}

runVitest(["shared"]);
