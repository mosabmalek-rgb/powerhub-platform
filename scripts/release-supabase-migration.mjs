import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertSupabaseMigrationTarget, SUPABASE_PROJECT_BY_TARGET } from "./supabase-migration-target.mjs";

const [requestedPath, target] = process.argv.slice(2);
const migrationRoot = path.resolve("supabase/migrations");

function fail(message) {
  console.error(`Supabase migration release blocked: ${message}`);
  process.exit(1);
}

if (!requestedPath || !Object.hasOwn(SUPABASE_PROJECT_BY_TARGET, target)) {
  fail("usage: node scripts/release-supabase-migration.mjs <supabase/migrations/file.sql> <staging|production>");
}

const absolutePath = path.resolve(requestedPath);
if (!absolutePath.startsWith(migrationRoot + path.sep)) {
  fail("only a migration inside supabase/migrations may be released");
}

const filename = path.basename(absolutePath);
const match = filename.match(/^(\d{14})_([a-z0-9_]+)\.sql$/);
if (!match) fail("release migration filenames must use a 14-digit timestamp and snake_case suffix");

const [, version, name] = match;
const actualProject = process.env.SUPABASE_PROJECT_REF;
const databaseUrl = process.env.SUPABASE_DB_URL;
try {
  assertSupabaseMigrationTarget({ target, projectRef: actualProject, databaseUrl });
} catch (error) {
  fail(error instanceof Error ? error.message : "Supabase database target validation failed");
}

const migrations = (await readdir(migrationRoot)).filter((entry) => entry.endsWith(".sql"));
const collisions = migrations.filter((entry) => entry !== filename && entry.startsWith(`${version}_`));
if (collisions.length) fail(`version ${version} already belongs to another file: ${collisions.join(", ")}`);

const sql = await readFile(absolutePath, "utf8");
if (!sql.trim()) fail("migration is empty");
if (sql.split("\n").some((line) => line.trimStart().startsWith("\\"))) fail("psql meta-commands are not allowed in a released migration");
if (/^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im.test(sql)) {
  fail("migration must not open or close its own transaction; release runner wraps SQL and ledger update atomically");
}
if (/\b(?:CREATE|DROP)\s+INDEX\s+CONCURRENTLY\b|^\s*VACUUM\b/im.test(sql)) {
  fail("non-transactional SQL is not supported by this atomic release runner; use a separately reviewed runbook");
}

function psql(query) {
  const result = spawnSync("psql", [
    "--no-psqlrc", "--no-password", "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align",
    "--dbname", databaseUrl, "--command", query,
  ], {
    encoding: "utf8",
    env: { ...process.env, PGSSLMODE: process.env.PGSSLMODE ?? "require", PGCONNECT_TIMEOUT: "15" },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "psql failed")
      .replaceAll(databaseUrl, "[redacted database URL]").trim().slice(-3000);
    fail(`psql failed safely (exit ${result.status ?? "unknown"}): ${detail}`);
  }
  return result.stdout.trim();
}

const existing = psql(
  `select 'APPLIED:' || coalesce(name, '<null>') from supabase_migrations.schema_migrations where version = '${version}'`,
);
if (existing) {
  if (existing !== `APPLIED:${name}`) {
    fail(`ledger version ${version} exists with a different name (${existing}); investigate drift instead of editing the ledger manually`);
  }
  console.log(`Migration ${version}_${name} is already recorded consistently; nothing changed.`);
  process.exit(0);
}

const transaction = `
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('powerhub:supabase:migration-release:v1', 0));
DO $powerhub_release_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '${version}') THEN
    RAISE EXCEPTION 'POWERHUB_MIGRATION_VERSION_RACE';
  END IF;
END
$powerhub_release_guard$;
${sql}
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('${version}', '${name}');
COMMIT;
`;

psql(transaction);
console.log(`Applied ${filename} to ${target} and atomically recorded version ${version} / name ${name}.`);
