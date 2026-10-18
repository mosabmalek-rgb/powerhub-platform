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
  const entryScriptTags = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*>/g)].map(([tag]) => tag);
  const preloadTags = [...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*>/g)].map(([tag]) => tag);
  const initialAssetTags = [...entryScriptTags, ...preloadTags];
  const heavyPatterns = [
    ["PDF renderer", /\bhtml2canvas\b|\bjspdf\b|\bjsPDF\b/],
    ["charting library", /\bResponsiveContainer\b|\bBarChart\b|\bAreaChart\b|\bCartesianGrid\b|\brecharts\b/],
    ["spreadsheet library", /\bExcelJS\b|\bexceljs\b/],
  ];
  const offending = [];

  for (const tag of initialAssetTags) {
    const href = tag.match(/(?:src|href)="([^"]+)"/)?.[1];
    if (!href) continue;
    const relativePath = href.replace(/^\/+/, "").split("?")[0];
    const assetPath = path.resolve(outputDirectory, relativePath);
    if (!assetPath.startsWith(outputDirectory + path.sep)) {
      throw new Error(`Unexpected modulepreload path in built HTML: ${href}`);
    }
    const asset = fs.readFileSync(assetPath, "utf8");
    const matches = heavyPatterns.filter(([, pattern]) => pattern.test(asset)).map(([label]) => label);
    if (matches.length) offending.push(`${href} (${matches.join(", ")})`);
  }

  if (offending.length) {
    console.error("[build] Dedicated invoice entry eagerly preloads report-only JavaScript:", offending.join("; "));
    console.error("[build] Keep PDF, chart and spreadsheet dependencies out of the dedicated invoice entry.");
    process.exit(1);
  }
}

assertPublicInvoiceEntryDoesNotPreloadReportLibraries();
run(["exec", "esbuild", "server/_core/index.ts", "--platform=node", "--packages=external", "--bundle", "--format=esm", "--outdir=dist"]);
