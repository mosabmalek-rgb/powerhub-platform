import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
const runnerTemp = process.env.RUNNER_TEMP;
if (!runnerTemp) throw new Error("RUNNER_TEMP is missing.");

const pgliteModule = path.join(
  runnerTemp,
  "pglite-sql-runtime",
  "node_modules",
  "@electric-sql",
  "pglite",
  "dist",
  "index.js",
);
const { PGlite } = await import(pathToFileURL(pgliteModule).href);

async function expandPsqlIncludes(filePath, ancestry = []) {
  const absolutePath = path.resolve(filePath);
  if (ancestry.includes(absolutePath)) {
    throw new Error(`Recursive SQL include detected: ${absolutePath}`);
  }

  const source = await readFile(absolutePath, "utf8");
  const lines = source.split(/\r?\n/);
  const output = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const include = trimmed.match(/^\\ir\s+(.+)$/);
    if (include) {
      const relativePath = include[1].trim().replace(/^["']|["']$/g, "");
      const nestedPath = path.resolve(path.dirname(absolutePath), relativePath);
      output.push(await expandPsqlIncludes(nestedPath, [...ancestry, absolutePath]));
      continue;
    }
    if (/^\\(?:set|echo)\b/.test(trimmed)) {
      output.push(`-- psql-only directive skipped by the embedded runner: ${trimmed}`);
      continue;
    }
    if (/^\\/.test(trimmed)) {
      throw new Error(`Unsupported psql meta-command in ${absolutePath}: ${trimmed}`);
    }
    output.push(line);
  }
  return output.join("\n");
}

const testPath = path.join(workspace, "supabase", "tests", "invoice_bulk_sms_safety.sql");
const sql = await expandPsqlIncludes(testPath);
const db = new PGlite();

try {
  console.log("PGLITE_POSTGRES_VERSION_CHECK");
  const version = await db.query("select version() as version");
  console.log(version.rows[0].version);
  console.log("INVOICE_BULK_SMS_SQL_FIXTURE_STARTED");
  await db.exec(sql);
  console.log("INVOICE_BULK_SMS_SQL_FIXTURE_PASSED");
} catch (error) {
  console.error("INVOICE_BULK_SMS_SQL_FIXTURE_FAILED");
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await db.close();
}
