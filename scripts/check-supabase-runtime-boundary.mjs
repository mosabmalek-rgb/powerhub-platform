import fs from "node:fs";
import path from "node:path";

const root = path.resolve("server");
const violations = [];
const excluded = new Set(["db.ts"]);
const forbidden = [
  { label: "getDb()", regex: /\bgetDb\s*\(/ },
  { label: "./db import", regex: /from\s+["']\.\/db["']/ },
  { label: "../drizzle import", regex: /from\s+["']\.\.\/drizzle\// },
  { label: "drizzle-orm import", regex: /from\s+["']drizzle-orm(?:\/[^"']*)?["']/ },
  { label: "mysql2 import", regex: /from\s+["']mysql2["']/ },
];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) inspect(full);
  }
}

function inspect(file) {
  const relative = path.relative(process.cwd(), file).replaceAll(path.sep, "/");
  const base = path.basename(file);
  if (excluded.has(base)) return;
  if (/\.test\.(?:ts|tsx|mts|cts)$/.test(base)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rule of forbidden) {
    const match = rule.regex.exec(text);
    if (match) violations.push(`${relative}: forbidden ${rule.label} at offset ${match.index}`);
  }
}

walk(root);
if (violations.length) {
  console.error("Supabase runtime boundary violation(s):");
  for (const item of violations) console.error(`- ${item}`);
  process.exit(1);
}
console.log("Supabase runtime boundary: PASS (no legacy DB/MySQL/Drizzle callers in server runtime)." );
