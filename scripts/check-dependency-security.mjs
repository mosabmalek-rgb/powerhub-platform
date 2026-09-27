import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
const lockfile = readFileSync("pnpm-lock.yaml", "utf8");

function versionOf(spec, name) {
  const value = spec?.[name];
  const match = typeof value === "string" ? value.match(/(\d+)\.(\d+)\.(\d+)/) : null;
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(actual, expected, label) {
  if (!actual || actual[0] < expected[0] || (actual[0] === expected[0] && (actual[1] < expected[1] || (actual[1] === expected[1] && actual[2] < expected[2])))) {
    throw new Error(`${label} must be >= ${expected.join(".")}; found ${actual?.join(".") ?? "missing"}`);
  }
}

const direct = packageJson.dependencies ?? {};
const dev = packageJson.devDependencies ?? {};
atLeast(versionOf(direct, "nanoid"), [5, 1, 16], "nanoid");
atLeast(versionOf(direct, "axios"), [1, 16, 0], "axios");
atLeast(versionOf(dev, "vite"), [7, 3, 5], "vite");
atLeast(versionOf(direct, "@trpc/server"), [11, 8, 0], "@trpc/server");

const requiredOverrides = {
  "fast-xml-parser": "5.5.6",
  tar: "7.5.21",
  postcss: "8.5.28",
  rollup: "4.59.0",
  "path-to-regexp": "0.1.13",
  picomatch: "4.0.7",
  lodash: "4.18.1",
  "lodash-es": "4.18.1",
  browserslist: "4.29.1",
  "form-data": "4.0.6",
};
for (const [name, version] of Object.entries(requiredOverrides)) {
  if (!new RegExp(`^\\s+${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:\\s*${version.replaceAll(".", "\\.")}\\s*$`, "m").test(workspace)) {
    throw new Error(`missing secure pnpm override: ${name}@${version}`);
  }
}

if (!lockfile.includes("lockfileVersion: '9.0'")) throw new Error("unsupported pnpm lockfile version");
if (lockfile.includes("nanoid@5.1.5") || lockfile.includes("postcss@8.5.6") || lockfile.includes("rollup@4.58.")) {
  throw new Error("lockfile contains a known high-severity vulnerable package version");
}

console.log("Dependency security guard passed: direct minimums, required overrides, and lockfile version checks are satisfied.");
