import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=4096", NODE_ENV: "production" };

function run(args) {
  const result = spawnSync(npmCommand, args, { stdio: "inherit", env, windowsHide: false, shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["exec", "vite", "build"]);
run(["exec", "esbuild", "server/_core/index.ts", "--platform=node", "--packages=external", "--bundle", "--format=esm", "--outdir=dist"]);
