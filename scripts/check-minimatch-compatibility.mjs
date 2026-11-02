import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const exceljsRequire = createRequire(require.resolve("exceljs"));
const archiver = exceljsRequire("archiver");
const archiverRequire = createRequire(exceljsRequire.resolve("archiver"));
const archiverUtilsRequire = createRequire(archiverRequire.resolve("archiver-utils"));
const readdirGlob = archiverRequire("readdir-glob");
const glob = archiverUtilsRequire("glob");
const globRequire = createRequire(archiverUtilsRequire.resolve("glob"));
const readdirRequire = createRequire(archiverRequire.resolve("readdir-glob"));

function packageVersion(requireFrom, packageName) {
  const manifestPath = requireFrom.resolve(packageName + "/package.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")).version;
}

assert.equal(packageVersion(globRequire, "minimatch"), "11.0.1", "glob must resolve minimatch 11.0.1");
assert.equal(packageVersion(readdirRequire, "minimatch"), "11.0.1", "readdir-glob must resolve minimatch 11.0.1");
assert.equal(packageVersion(archiverUtilsRequire, "glob"), "7.2.3", "archiver-utils must exercise glob 7.2.3");
assert.equal(packageVersion(archiverRequire, "readdir-glob"), "1.1.3", "archiver must exercise readdir-glob 1.1.3");
assert.equal(packageVersion(exceljsRequire, "archiver"), "5.3.2", "ExcelJS must exercise archiver 5.3.2");

const globMinimatch = globRequire("minimatch");
const readdirMinimatch = readdirRequire("minimatch");
assert.equal(typeof globMinimatch.Minimatch, "function", "glob's Minimatch constructor must remain available");
assert.equal(typeof globMinimatch.GLOBSTAR, "symbol", "glob's GLOBSTAR symbol must remain available");
assert.equal(typeof readdirMinimatch.Minimatch, "function", "readdir-glob's named Minimatch export must remain available");
assert.equal(new globMinimatch.Minimatch("**/*.txt").match("nested/receipt.txt"), true);
assert.equal(new readdirMinimatch.Minimatch("**/*.txt").match("nested/receipt.txt"), true);

const tempDir = mkdtempSync(path.join(tmpdir(), "powerhub-minimatch-compat-"));
try {
  mkdirSync(path.join(tempDir, "nested"));
  writeFileSync(path.join(tempDir, "root.txt"), "root fixture");
  writeFileSync(path.join(tempDir, "nested", "receipt.txt"), "nested fixture");

  const globMatches = glob.sync("**/*.txt", { cwd: tempDir, nodir: true }).sort();
  assert.deepEqual(globMatches, ["nested/receipt.txt", "root.txt"], "glob 7 must match using minimatch 11");

  const readdirMatches = await new Promise((resolve, reject) => {
    const stream = readdirGlob(tempDir, { pattern: "**/*.txt", nodir: true }, (error, matches) => {
      if (error) reject(error);
      else resolve(matches);
    });
    stream.on("error", reject);
  });
  assert.deepEqual(
    [...readdirMatches].sort(),
    ["nested/receipt.txt", "root.txt"],
    "readdir-glob must match using minimatch 11"
  );

  const zipBuffer = await new Promise((resolve, reject) => {
    const archive = archiver("zip");
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.directory(tempDir, false);
    const finalization = archive.finalize();
    if (finalization && typeof finalization.catch === "function") finalization.catch(reject);
  });
  assert.ok(zipBuffer.length > 22, "archiver must complete a ZIP using readdir-glob and minimatch 11");

  console.log("Matcher compatibility passed: minimatch 11.0.1 with glob 7.2.3, readdir-glob 1.1.3, and archiver 5.3.2.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
