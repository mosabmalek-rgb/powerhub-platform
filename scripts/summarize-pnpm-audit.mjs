import { readFileSync } from "node:fs";

const reportPath = process.argv[2];
const commandExitCode = Number(process.argv[3] ?? "0");
if (!reportPath) throw new Error("Usage: node scripts/summarize-pnpm-audit.mjs <report.json> <pnpm-exit-code>");

const reportText = readFileSync(reportPath, "utf8").trim();
if (!reportText) throw new Error("pnpm audit produced an empty JSON report.");

let report;
try {
  report = JSON.parse(reportText);
} catch (error) {
  throw new Error("pnpm audit output is not valid JSON: " + error.message);
}

const advisoryMap = report.advisories ?? report.auditReport?.advisories ?? {};
if (!advisoryMap || typeof advisoryMap !== "object" || Array.isArray(advisoryMap)) {
  throw new Error("pnpm audit JSON did not contain an advisories object.");
}

const entries = Object.entries(advisoryMap);
const levels = ["critical", "high", "moderate", "low", "info"];
const metadataCounts = report.metadata?.vulnerabilities ?? {};
const derivedCounts = Object.fromEntries(levels.map((level) => [
  level,
  entries.filter(([, advisory]) => String(advisory.severity ?? "").toLowerCase() === level).length
]));
const counts = Object.keys(metadataCounts).length > 0 ? metadataCounts : derivedCounts;
const findingsCount = entries.reduce((total, [, advisory]) => {
  return total + (Array.isArray(advisory.findings) && advisory.findings.length > 0 ? advisory.findings.length : 1);
}, 0);

function cell(value) {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

const lines = [
  "## Full pnpm lockfile advisory report",
  "",
  "- Audit scope: all lockfile dependency groups (production, development, and optional dependencies as included by pnpm).",
  "- pnpm audit command exit code: " + commandExitCode + " (a non-zero code can mean advisories were found; inspect the counts and entries below).",
  "- Unique advisories: " + entries.length,
  "- Affected package/version findings: " + findingsCount,
  "- Severity counts: " + levels.map((level) => level + " " + Number(counts[level] ?? 0)).join(" · "),
  "",
  "| Advisory | Package | Severity | Installed version(s) | Patched version(s) | Dependency paths |",
  "|---|---|---|---|---|---|"
];

for (const [id, advisory] of entries.sort((a, b) => {
  const order = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
  const left = order[String(a[1].severity ?? "").toLowerCase()] ?? 9;
  const right = order[String(b[1].severity ?? "").toLowerCase()] ?? 9;
  return left - right || String(a[0]).localeCompare(String(b[0]));
})) {
  const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
  const versions = [...new Set(findings.map((finding) => finding.version).filter(Boolean))];
  const paths = [...new Set(findings.flatMap((finding) => Array.isArray(finding.paths) ? finding.paths : []))];
  let patched = "Not stated";
  if (Object.prototype.hasOwnProperty.call(advisory, "patched_versions")) {
    patched = advisory.patched_versions || "No published patch";
  } else if (advisory.fix_available === false) {
    patched = "No published patch";
  } else if (advisory.fix_available) {
    patched = "Update available";
  }
  const packageName = advisory.module_name ?? advisory.name ?? advisory.package?.name ?? "unknown";
  const ghsa = advisory.ghsa_id ?? advisory.github_advisory_id ?? id;
  const pathText = paths.slice(0, 4).join("<br>") + (paths.length > 4 ? "<br>+ " + (paths.length - 4) + " more" : "");
  lines.push(
    "| " + cell(ghsa) +
    " | " + cell(packageName) +
    " | " + cell(advisory.severity) +
    " | " + cell(versions.join(", ")) +
    " | " + cell(patched) +
    " | " + cell(pathText) + " |"
  );
}

if (entries.length === 0) lines.push("| — | No advisories reported | — | — | — | — |");
lines.push(
  "",
  "- Known compatibility exception: glob@7.2.3 remains pinned to minimatch@3.1.5 until the ExcelJS/Archiver legacy consumer is replaced; this is unresolved and is not counted as patched.",
  "> This is the registry-based pnpm audit report, not GitHub's Dependabot alert feed. Its advisory IDs and total can differ from the repository's 83 Dependabot alerts; use both sources during reconciliation.",
  ""
);

process.stdout.write(lines.join("\n"));
