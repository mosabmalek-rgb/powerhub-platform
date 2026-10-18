import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const npmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const env = { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=4096", NODE_ENV: "production" };

function run(args) {
  const result = spawnSync(npmCommand, args, { stdio: "inherit", env, windowsHide: false, shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["exec", "vite", "build"]);

function assertPublicInvoiceEntryDoesNotPreloadReportLibraries() {
  const outputDirectory = path.resolve("dist/public");
  const html = fs.readFileSync(path.join(outputDirectory, "index.html"), "utf8");
  const preloadTags = [...html.matchAll(/<link\b[^>]*\brel=["']modulepreload["'][^>]*>/g)].map(([tag]) => tag);
  const heavyPatterns = [
    ["PDF renderer", /\bhtml2canvas\b|\bjspdf\b|\bjsPDF\b/],
    ["charting library", /\bResponsiveContainer\b|\bBarChart\b|\bAreaChart\b|\bCartesianGrid\b|\brecharts\b/],
    ["spreadsheet library", /\bExcelJS\b|\bexceljs\b/],
  ];
  const offending = [];

  for (const tag of preloadTags) {
    const href = tag.match(/\bhref=["']([^"']+)["']/)?.[1];
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
    console.error("[build] Public invoice entry eagerly preloads report-only JavaScript:", offending.join("; "));
    console.error("[build] Keep PDF, chart and spreadsheet dependencies inside lazy route chunks.");
    process.exit(1);
  }
}

assertPublicInvoiceEntryDoesNotPreloadReportLibraries();
run(["exec", "esbuild", "server/_core/index.ts", "--platform=node", "--packages=external", "--bundle", "--format=esm", "--outdir=dist"]);
