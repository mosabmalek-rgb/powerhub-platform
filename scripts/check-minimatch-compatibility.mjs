import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);
const exceljsRequire = createRequire(require.resolve("exceljs"));
const ExcelJS = exceljsRequire("exceljs");
const unzipper = exceljsRequire("unzipper");
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

function resolvedPackageVersion(requireFrom, packageName) {
  let directory = path.dirname(requireFrom.resolve(packageName));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === packageName) return manifest.version;
    } catch {
      // Continue walking up from an entry file until the owning package root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not find package.json for resolved package: ${packageName}`);
}

assert.equal(packageVersion(globRequire, "minimatch"), "11.0.3", "archiver-utils glob 14 must resolve patched minimatch 11.0.3");
assert.equal(packageVersion(readdirRequire, "minimatch"), "11.0.3", "readdir-glob must use patched minimatch 11.0.3");
assert.equal(packageVersion(archiverUtilsRequire, "glob"), "14.0.3", "archiver-utils must resolve fixed glob 14.0.3");
assert.equal(packageVersion(archiverRequire, "archiver-utils"), "5.0.2", "Archiver must run with archiver-utils 5.0.2");
assert.equal(packageVersion(archiverRequire, "readdir-glob"), "1.1.3", "archiver must exercise readdir-glob 1.1.3");
assert.equal(packageVersion(exceljsRequire, "archiver"), "5.3.2", "ExcelJS must exercise archiver 5.3.2");
assert.equal(packageVersion(exceljsRequire, "uuid"), "11.1.1", "ExcelJS must resolve patched UUID while preserving CommonJS support");
assert.equal(packageVersion(exceljsRequire, "tmp"), "0.2.7", "ExcelJS must resolve patched tmp");
assert.equal(resolvedPackageVersion(exceljsRequire, "unzipper"), "0.12.5", "ExcelJS must resolve patched unzipper 0.12.5");
assert.equal(typeof unzipper.Parse, "function", "unzipper CommonJS compatibility must expose Parse for ExcelJS WorkbookReader");

const globMinimatch = globRequire("minimatch");
const readdirMinimatch = readdirRequire("minimatch");
assert.equal(typeof globMinimatch.Minimatch, "function", "glob's legacy Minimatch constructor must remain available");
assert.equal(typeof glob.sync, "function", "glob 14 must retain the synchronous compatibility API used by archiver-utils");
assert.equal(typeof readdirMinimatch.Minimatch, "function", "readdir-glob's named Minimatch export must remain available");
assert.equal(new globMinimatch.Minimatch("**/*.txt").match("nested/receipt.txt"), true);
assert.equal(new readdirMinimatch.Minimatch("**/*.txt").match("nested/receipt.txt"), true);

const tempDir = mkdtempSync(path.join(tmpdir(), "powerhub-minimatch-compat-"));
try {
  mkdirSync(path.join(tempDir, "nested"));
  writeFileSync(path.join(tempDir, "root.txt"), "root fixture");
  writeFileSync(path.join(tempDir, "nested", "receipt.txt"), "nested fixture");

  const archiverUtils = archiverRequire("archiver-utils");
  const utilityGlobMatches = archiverUtils.file.expand({ cwd: tempDir, nodir: true }, ["**/*.txt"]).sort();
  assert.deepEqual(utilityGlobMatches, ["nested/receipt.txt", "root.txt"], "archiver-utils file expansion must work with glob 14 and minimatch 11");

  const globMatches = glob.sync("**/*.txt", { cwd: tempDir, nodir: true }).sort();
  assert.deepEqual(globMatches, ["nested/receipt.txt", "root.txt"], "archiver-utils glob 14 must match with patched minimatch 11");

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

  // ExcelJS streaming reads use unzipper.Parse({ forceStream: true }); exercise
  // that exact CommonJS path to prove unzipper 0.12.5 remains API-compatible.
  const streamedValues = [];
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(
    Readable.from([Buffer.from(workbookBuffer)]),
    { sharedStrings: "cache", styles: "cache" }
  );
  await new Promise((resolve, reject) => {
    workbookReader.on("worksheet", (worksheetReader) => {
      worksheetReader.on("row", (row) => streamedValues.push(row.getCell(2).value));
    });
    workbookReader.on("error", reject);
    workbookReader.on("finished", resolve);
    workbookReader.read();
  });
  assert.deepEqual(streamedValues, ["value", "round-trip"], "ExcelJS streaming XLSX import must remain compatible with unzipper 0.12.5");

  console.log("Dependency compatibility passed: Archiver 5 + archiver-utils 5/glob 14 + readdir-glob/minimatch 11 + ExcelJS streaming unzipper 0.12.5.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
