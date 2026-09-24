import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=12288" };

function run(args, timeoutMs = 5 * 60_000) {
  const result = spawnSync(npmCommand, args, {
    stdio: "inherit",
    env,
    windowsHide: false,
    shell: process.platform === "win32",
    timeout: timeoutMs,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      console.error(`Timed out after ${timeoutMs}ms: ${npmCommand} ${args.join(" ")}`);
      process.exit(124);
    }
    throw result.error;
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const vitestArgs = ["vitest", "run", "--maxWorkers=1", "--minWorkers=1"];
const pageVitestArgs = [...vitestArgs, "--config", "vitest.pages.config.ts"];

function runVitest(paths) {
  run([...vitestArgs, ...paths]);
}

runVitest(["server"]);
runVitest(["client/src/components"]);
runVitest(["client/src/lib", "client/src/contexts", "client/src/hooks"]);

const pagesDir = "client/src/pages";
if (existsSync(pagesDir)) {
  const roleGuardsPath = "client/src/pages/role-guards.ui.test.tsx";
  if (existsSync(roleGuardsPath)) {
    const pageTests = readFileSync(roleGuardsPath, "utf8");
    const names = [...pageTests.matchAll(/^\s*it\(\s*["']([^"']+)["']/gm)].map((match) => match[1]);
    for (const name of names) {
      run(pageVitestArgs.concat(["client/src/pages/role-guards.ui.test.tsx", "-t", name]), 60_000);
    }
  }
  for (const entry of ["client/src/pages/BillingPage.test.tsx", "client/src/pages/OperationsPage.test.tsx", "client/src/pages/SettingsPage.test.tsx"]) {
    if (existsSync(entry)) run(pageVitestArgs.concat([entry]));
  }
}

runVitest(["shared"]);
