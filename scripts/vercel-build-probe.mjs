import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const outDir = resolve(root, "dist/public");
const diagnosticPath = resolve(outDir, "build-debug.txt");
const indexPath = resolve(outDir, "index.html");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
    shell: false,
  });
  return {
    code: result.status ?? 1,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

mkdirSync(outDir, { recursive: true });

const sections = [];
const vite = run("pnpm", ["vite", "build"]);
sections.push("=== VITE BUILD ===\n" + JSON.stringify(vite, null, 2));

if (vite.code === 0) {
  const server = run("pnpm", [
    "esbuild",
    "server/_core/index.ts",
    "--platform=node",
    "--packages=external",
    "--bundle",
    "--format=esm",
    "--outdir=dist",
  ]);
  sections.push("=== SERVER ESBUILD ===\n" + JSON.stringify(server, null, 2));
}

writeFileSync(diagnosticPath, sections.join("\n\n"), "utf8");
writeFileSync(
  indexPath,
  '<!doctype html><html><head><meta charset="utf-8"><title>PowerHub Build Diagnostic</title></head><body><h1>Build diagnostic deployment</h1><p><a href="/build-debug.txt">Open build diagnostics</a></p></body></html>',
  "utf8",
);
process.exit(0);
