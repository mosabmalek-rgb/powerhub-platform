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
  minimatch: "11.0.1",
  "postcss-selector-parser": "6.1.5",
  qs: "6.17.1",
  undici: "8.12.2",
  postcss: "8.5.28",
  rollup: "4.59.0",
  "path-to-regexp": "0.1.13",
  picomatch: "4.0.7",
  lodash: "4.18.1",
  "lodash-es": "4.18.1",
  browserslist: "4.29.1",
  "form-data": "4.0.6",
  "proxy-addr": "2.0.8",
  dompurify: "3.4.17",
  "brace-expansion@^1.0.0": "1.1.20",
  "brace-expansion@^2.0.0": "2.1.6",
  "follow-redirects": "1.16.2",
  zod: "4.6.6",
  "body-parser": "1.20.9",
};
for (const [name, version] of Object.entries(requiredOverrides)) {
  const expectedLine = `${name}: ${version}`;
  const hasOverride = workspace.split("\n").some((line) => line.trim() === expectedLine);
  if (!hasOverride) {
    throw new Error(`missing secure pnpm override: ${name}@${version}`);
  }
}

if (!lockfile.includes("lockfileVersion: '9.0'")) throw new Error("unsupported pnpm lockfile version");
const vulnerableLockEntries = [
  "proxy-addr@2.0.7",
  "dompurify@3.4.16",
  "dompurify@3.4.14",
  "brace-expansion@1.1.18",
  "brace-expansion@2.1.4",
  "follow-redirects@1.16.0",
  "zod@4.1.12",
  "body-parser@1.20.3",
  "nanoid@5.1.5",
  "postcss@8.5.6",
  "minimatch@3.1.5",
  "minimatch@5.1.9",
  "postcss-selector-parser@6.0.10",
  "qs@6.13.0",
  "undici@8.10.0",
];
const remainingVulnerableEntries = vulnerableLockEntries.filter((entry) => lockfile.includes(entry));
if (remainingVulnerableEntries.length > 0) {
  throw new Error(`lockfile contains vulnerable package entries: ${remainingVulnerableEntries.join(", ")}`);
}

const requiredPatchedLockEntries = [
  "minimatch@11.0.1",
  "postcss-selector-parser@6.1.5",
  "qs@6.17.1",
  "undici@8.12.2",
  "body-parser@1.20.9",
  "follow-redirects@1.16.2",
];
const missingPatchedLockEntries = requiredPatchedLockEntries.filter((entry) => !lockfile.includes(entry));
if (missingPatchedLockEntries.length > 0) {
  throw new Error(`lockfile is missing required patched package entries: ${missingPatchedLockEntries.join(", ")}`);
}

console.log("Dependency security guard passed: minimums, all six Dependabot overrides, patched lock entries, and vulnerable-version exclusions are satisfied.");
