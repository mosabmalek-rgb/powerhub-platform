import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const exceljsRequire = createRequire(require.resolve("exceljs"));
const ExcelJS = exceljsRequire("exceljs");
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

assert.equal(packageVersion(globRequire, "minimatch"), "3.1.5", "legacy glob 7 must keep its compatible minimatch 3 edge");
assert.equal(packageVersion(readdirRequire, "minimatch"), "11.0.3", "readdir-glob must use patched minimatch 11.0.3");
assert.equal(packageVersion(archiverUtilsRequire, "glob"), "7.2.3", "archiver-utils must exercise glob 7.2.3");
assert.equal(packageVersion(archiverRequire, "readdir-glob"), "1.1.3", "archiver must exercise readdir-glob 1.1.3");
assert.equal(packageVersion(exceljsRequire, "archiver"), "5.3.2", "ExcelJS must exercise archiver 5.3.2");
assert.equal(packageVersion(exceljsRequire, "uuid"), "11.1.1", "ExcelJS must resolve patched UUID while preserving CommonJS support");
assert.equal(packageVersion(exceljsRequire, "tmp"), "0.2.7", "ExcelJS must resolve patched tmp");

const globMinimatch = globRequire("minimatch");
const readdirMinimatch = readdirRequire("minimatch");
assert.equal(typeof globMinimatch.Minimatch, "function", "glob's legacy Minimatch constructor must remain available");
assert.ok(globMinimatch.GLOBSTAR && typeof globMinimatch.GLOBSTAR === "object", "glob 7 must retain its legacy GLOBSTAR matcher sentinel");
assert.equal(typeof readdirMinimatch.Minimatch, "function", "readdir-glob's named Minimatch export must remain available");
assert.equal(new globMinimatch.Minimatch("**/*.txt").match("nested/receipt.txt"), true);
assert.equal(new readdirMinimatch.Minimatch("**/*.txt").match("nested/receipt.txt"), true);

const tempDir = mkdtempSync(path.join(tmpdir(), "powerhub-minimatch-compat-"));
try {
  mkdirSync(path.join(tempDir, "nested"));
  writeFileSync(path.join(tempDir, "root.txt"), "root fixture");
  writeFileSync(path.join(tempDir, "nested", "receipt.txt"), "nested fixture");

  const globMatches = glob.sync("**/*.txt", { cwd: tempDir, nodir: true }).sort();
  assert.deepEqual(globMatches, ["nested/receipt.txt", "root.txt"], "glob 7 must keep matching with its compatible minimatch major");

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
    "readdir-glob must match using patched minimatch 11.0.3"
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
  assert.ok(zipBuffer.length > 22, "Archiver must complete a ZIP using readdir-glob and the patched matcher");

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Compatibility");
  sheet.addRow(["scope", "value"]);
  sheet.addRow(["security", "round-trip"]);
  const workbookBuffer = await workbook.xlsx.writeBuffer();
  assert.ok(workbookBuffer.byteLength > 100, "ExcelJS must export a workbook with patched UUID and tmp dependencies");

  const roundTrip = new ExcelJS.Workbook();
  await roundTrip.xlsx.load(workbookBuffer);
  assert.equal(roundTrip.getWorksheet("Compatibility").getCell("B2").value, "round-trip");
  console.log("Legacy dependency compatibility passed: glob 7 isolated on minimatch 3; readdir-glob and ExcelJS export/import pass with patched dependencies.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
