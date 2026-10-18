import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const npmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=4096", NODE_ENV: "production" };

function run(args, extraEnv = {}) {
  const result = spawnSync(npmCommand, args, { stdio: "inherit", env: { ...env, ...extraEnv }, windowsHide: false, shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Build the workspace entry first. Then build the public invoice with an isolated
// Rollup graph, preserving the workspace output rather than combining both entry graphs.
run(["exec", "vite", "build"]);
run(["exec", "vite", "build"], { POWERHUB_INVOICE_ONLY: "1" });

function assertPublicInvoiceEntryDoesNotPreloadReportLibraries() {
  const outputDirectory = path.resolve("dist/public");
  const html = fs.readFileSync(path.join(outputDirectory, "invoice.html"), "utf8");
  const manifestPath = path.join(outputDirectory, "invoice-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // Resolve the actual JS entry referenced by invoice.html instead of relying
  // on Vite's HTML-manifest key shape. The invoice-only build can name this key
  // "invoice.html" while its emitted JS entry is a separate manifest record.
  const moduleScripts = [...html.matchAll(/<script\\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => /\\btype=["']module["']/i.test(tag))
    .map((tag) => tag.match(/\\bsrc=["']([^"']+)["']/i)?.[1])
    .filter((src) => typeof src === "string");
  if (!moduleScripts.length) {
    throw new Error("Dedicated invoice HTML has no module script to inspect.");
  }
  const entryFile = moduleScripts[0].replace(/^\\//, "");
  const entryRecord = Object.values(manifest).find((record) => record.file === entryFile);
  if (!entryRecord) {
    const emitted = Object.values(manifest).map((record) => record.file).filter(Boolean);
    throw new Error(`Dedicated invoice JS entry is missing from its manifest. Entry: ${entryFile}; emitted files: ${emitted.join(", ")}`);
  }

  // Traverse only static imports. Dynamic imports are intentionally excluded
  // because they must execute only when the user clicks Download PDF.
  const visited = new Set();
  const queue = [entryRecord.file, ...(entryRecord.imports ?? [])];
  const heavyPatterns = [
    ["PDF renderer", /(?:html2canvas|jspdf)/i],
    ["charting library", /(?:recharts|charts[-.])/i],
    ["spreadsheet library", /(?:exceljs|report-spreadsheets)/i],
  ];
  const offending = [];
  while (queue.length) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    if (heavyPatterns.some(([, pattern]) => pattern.test(file))) {
      offending.push(file);
      continue;
    }
    const record = Object.values(manifest).find((item) => item.file === file);
    if (record?.imports) queue.push(...record.imports);
  }

  if (offending.length) {
    console.error("[build] Dedicated invoice entry statically imports report-only JavaScript:", [...new Set(offending)].join("; "));
    console.error("[build] Keep PDF, chart and spreadsheet dependencies behind dynamic imports.");
    process.exit(1);
  }
}
assertPublicInvoiceEntryDoesNotPreloadReportLibraries();
run(["exec", "esbuild", "server/_core/index.ts", "--platform=node", "--packages=external", "--bundle", "--format=esm", "--outdir=dist"]);
