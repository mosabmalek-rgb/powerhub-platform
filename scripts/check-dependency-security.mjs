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
    throw new Error(\`\${label} must be >= \${expected.join(".")}; found \${actual?.join(".") ?? "missing"}\`);
  }
}

const direct = packageJson.dependencies ?? {};
const dev = packageJson.devDependencies ?? {};
atLeast(versionOf(direct, "nanoid"), [5, 1, 16], "nanoid");
atLeast(versionOf(direct, "axios"), [1, 16, 0], "axios");
atLeast(versionOf(direct, "@trpc/server"), [11, 8, 0], "@trpc/server");
atLeast(versionOf(dev, "vite"), [7, 3, 7], "vite");
atLeast(versionOf(dev, "vitest"), [4, 1, 12], "vitest");

const requiredOverrides = {
  "fast-xml-parser": "5.11.2",
  tar: "7.5.21",
  minimatch: "11.0.3",
  "glob@7.2.3>minimatch": "3.1.5",
  "readdir-glob@1.1.3>minimatch": "11.0.3",
  uuid: "11.1.1",
  tmp: "0.2.7",
  "@smithy/config-resolver": "4.7.2",
  mermaid: "11.17.2",
  katex: "0.18.10",
  "mdast-util-to-hast": "13.2.1",
  "@babel/core": "7.29.7",
  "source-map-js": "1.2.2",
  tinypool: "2.2.0",
  vite: "7.3.7",
  postcss: "8.5.28",
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
  "postcss-selector-parser": "6.1.5",
  qs: "6.17.1",
  undici: "8.12.2",
  rollup: "4.59.0",
};
for (const [name, version] of Object.entries(requiredOverrides)) {
  const expectedLine = `${name}: ${version}`;
  const quotedExpectedLine = `"${name}": ${version}`;
  if (!workspace.split(/\r?\n/).some((line) => line.trim() === expectedLine || line.trim() === quotedExpectedLine)) {
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
  "minimatch@5.1.9",
  "postcss-selector-parser@6.0.10",
  "qs@6.13.0",
  "undici@8.10.0",
  "fast-xml-parser@5.5.6",
  "mermaid@11.12.0",
  "vite@7.3.6",
  "vitest@3.2.7",
  "@vitest/mocker@3.2.7",
  "tinypool@1.1.1",
  "source-map-js@1.2.1",
  "katex@0.16.25",
  "mdast-util-to-hast@13.2.0",
  "uuid@8.3.2",
  "uuid@11.1.0",
  "@smithy/config-resolver@4.3.0",
  "@babel/core@7.28.4",
];
const remainingVulnerableEntries = vulnerableLockEntries.filter((entry) => lockfile.includes(entry));
if (remainingVulnerableEntries.length > 0) {
  throw new Error(\`lockfile contains vulnerable package entries: \${remainingVulnerableEntries.join(", ")}\`);
}

// glob@7.2.3 is an isolated legacy consumer used by the current ExcelJS/Archiver
// tree. It cannot run against minimatch 11's matcher internals. Keep only that
// exact edge on minimatch 3 until the legacy consumer is replaced; readdir-glob
// and all other consumers must resolve the patched 11.0.3 release.
const globSnapshot = lockfile.split("  glob@7.2.3:\\n").pop()?.split(/\\n  [^ ]/)[0] ?? "";
const legacyMatcherReferences = lockfile.match(/      minimatch: 3\\.1\\.5/g) ?? [];
if (!globSnapshot.includes("      minimatch: 3.1.5") || legacyMatcherReferences.length !== 1) {
  throw new Error("legacy minimatch exception is not narrowly limited to glob@7.2.3.");
}
if (lockfile.includes("minimatch@5.1.9")) {
  throw new Error("vulnerable minimatch 5.x must not remain in the lockfile.");
}

const requiredPatchedLockEntries = [
  "fast-xml-parser@5.11.2",
  "minimatch@11.0.3",
  "uuid@11.1.1",
  "tmp@0.2.7",
  "mermaid@11.17.2",
  "katex@0.18.10",
  "mdast-util-to-hast@13.2.1",
  "source-map-js@1.2.2",
  "tinypool@2.2.0",
  "vite@7.3.7",
  "vitest@4.1.12",
  "@vitest/mocker@4.1.12",
  "@smithy/config-resolver@4.7.2",
  "@babel/core@7.29.7",
  "postcss-selector-parser@6.1.5",
  "qs@6.17.1",
  "undici@8.12.2",
  "body-parser@1.20.9",
  "follow-redirects@1.16.2",
];
const missingPatchedLockEntries = requiredPatchedLockEntries.filter((entry) => !lockfile.includes(entry));
if (missingPatchedLockEntries.length > 0) {
  throw new Error(\`lockfile is missing required patched package entries: \${missingPatchedLockEntries.join(", ")}\`);
}

console.warn("Known unresolved dependency boundary: glob@7.2.3 -> minimatch@3.1.5 remains isolated for ExcelJS/Archiver compatibility; it is not suppressed or treated as patched.");
console.log("Dependency security guard passed: required fixes are pinned, vulnerable lock entries are removed, and the remaining legacy matcher edge is explicitly constrained.");
