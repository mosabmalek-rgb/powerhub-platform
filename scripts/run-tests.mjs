import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=4096" };

function run(args) {
  const result = spawnSync(npmCommand, args, { stdio: "inherit", env, windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["vitest", "run", "server"]);
run(["vitest", "run", "client/src/components"]);
run(["vitest", "run", "client/src/lib", "client/src/contexts", "client/src/hooks"]);

const pagesDir = "client/src/pages";
if (existsSync(pagesDir)) {
  const roleGuardsPath = "client/src/pages/role-guards.ui.test.tsx";
  if (existsSync(roleGuardsPath)) {
    const pageTests = readFileSync(roleGuardsPath, "utf8");
    const names = [...pageTests.matchAll(/^\s*it\(\s*["']([^"']+)["']/gm)].map((match) => match[1]);
    for (const name of names) run(["vitest", "run", "client/src/pages/role-guards.ui.test.tsx", "-t", name]);
  }
  for (const entry of ["client/src/pages/BillingPage.test.tsx", "client/src/pages/OperationsPage.test.tsx", "client/src/pages/SettingsPage.test.tsx"]) {
    if (existsSync(entry)) run(["vitest", "run", entry]);
  }
}

run(["vitest", "run", "shared"]);
