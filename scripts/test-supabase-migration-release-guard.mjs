import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { buildSupabaseMigrationTransaction } from "./supabase-migration-transaction.mjs";
import {
  classifySupabaseMigrationHistory,
  computeSupabaseMigrationContentSha256,
  parseSupabaseMigrationHistoryRows,
} from "./supabase-migration-target.mjs";

// This script writes synthetic histories. Refuse deployed databases, including
// either real Supabase project, even when inherited credentials are present.
assert.equal(process.env.PGHOST, "127.0.0.1");
assert.equal(process.env.PGDATABASE, "supabase_migration_release_guard_test");
assert.match(process.env.PGPORT ?? "", /^\d+$/);
assert.ok(process.env.PGUSER);
const args = ["-X", "-w", "-v", "ON_ERROR_STOP=1", "-At",
  "-h", process.env.PGHOST, "-p", process.env.PGPORT,
  "-U", process.env.PGUSER, "-d", process.env.PGDATABASE];

function psql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(sql);
  });
}
async function ok(sql) {
  const result = await psql(sql);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}
async function reset() {
  await ok("TRUNCATE supabase_migrations.schema_migrations, public.release_guard_effects;");
}
const candidate = {
  version: "20990101000001", name: "synthetic_release_guard",
  sql: "INSERT INTO public.release_guard_effects VALUES ('first');",
};
const history = () => ok(`SELECT version || '|' || name || '|' ||
  CASE WHEN statements IS NULL OR cardinality(statements)=0
    OR nullif(array_to_string(statements, E'\\n'),'') IS NULL THEN 'unavailable'
    ELSE encode(sha256(convert_to(array_to_string(statements, E'\\n'),'UTF8')),'hex') END
  FROM supabase_migrations.schema_migrations ORDER BY version;`);
const classify = async () => classifySupabaseMigrationHistory({
  ...candidate, contentSha: computeSupabaseMigrationContentSha256(candidate.sql),
  records: parseSupabaseMigrationHistoryRows(await history()),
});

await ok(`CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text NOT NULL,statements text[]);
CREATE TABLE public.release_guard_effects(marker text NOT NULL);`);
assert.equal(await classify(), "not-applied");
await ok(buildSupabaseMigrationTransaction(candidate));
assert.equal(await classify(), "already-applied");
assert.equal(await ok("SELECT count(*) FROM public.release_guard_effects;"), "1");

// Real stored histories exercise the same parser/classifier as the runner.
await ok("UPDATE supabase_migrations.schema_migrations SET statements=ARRAY['different SQL'];");
await assert.rejects(classify, /different SQL content/);
for (const payload of ["NULL", "ARRAY[]::text[]", "ARRAY['']::text[]"]) {
  await ok(`UPDATE supabase_migrations.schema_migrations SET statements=${payload};`);
  await assert.rejects(classify, /payload is unavailable/);
}
await ok("UPDATE supabase_migrations.schema_migrations SET version='20990101000002';");
await assert.rejects(classify, /already recorded under version/);
await ok("INSERT INTO supabase_migrations.schema_migrations VALUES ('20990101000003','synthetic_release_guard',NULL);");
await assert.rejects(classify, /appears more than once/);
await reset();
await ok("INSERT INTO supabase_migrations.schema_migrations VALUES ('20990101000001','different_name',NULL);");
await assert.rejects(classify, /different name/);

// The initial lookup can observe an empty ledger in two release processes.
// Both execute the actual production transaction builder, never a test copy.
for (const sameVersion of [false, true]) {
  await reset();
  assert.equal(await classify(), "not-applied");
  const other = { ...candidate,
    version: sameVersion ? candidate.version : "20990101000002",
    name: sameVersion ? "another_name" : candidate.name,
    sql: "INSERT INTO public.release_guard_effects VALUES ('second');",
  };
  const results = await Promise.all([
    // A deployment/session default must not pin a stale snapshot while waiting
    // for the advisory lock. The production builder explicitly selects RC.
    psql("SET default_transaction_isolation='repeatable read';\n" +
      buildSupabaseMigrationTransaction({ ...candidate,
        sql: "SELECT pg_sleep(0.2);\n" + candidate.sql })),
    psql("SET default_transaction_isolation='repeatable read';\n" +
      buildSupabaseMigrationTransaction(other)),
  ]);
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.match(results.find((result) => result.code !== 0).stderr,
    sameVersion ? /POWERHUB_MIGRATION_VERSION_RACE/ : /POWERHUB_MIGRATION_NAME_RACE/);
  assert.equal(await ok("SELECT count(*) FROM supabase_migrations.schema_migrations;"), "1");
  assert.equal(await ok("SELECT count(*) FROM public.release_guard_effects;"), "1");
}

// SQL failure cannot leave business side effects or an applied ledger row.
await reset();
const failed = await psql(buildSupabaseMigrationTransaction({ ...candidate,
  sql: candidate.sql + "\nSELECT 1 / 0;" }));
assert.notEqual(failed.code, 0);
assert.match(failed.stderr, /division by zero/);
assert.equal(await ok("SELECT count(*) FROM public.release_guard_effects;"), "0");
assert.equal(await ok("SELECT count(*) FROM supabase_migrations.schema_migrations;"), "0");

// Also fail after the migration SQL, during history persistence. Its business
// changes must roll back together with the rejected ledger INSERT.
await ok(`CREATE FUNCTION public.reject_test_ledger_write() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_LEDGER_WRITE_FAILURE'; END $$;
CREATE TRIGGER reject_test_ledger_write BEFORE INSERT
ON supabase_migrations.schema_migrations FOR EACH ROW
EXECUTE FUNCTION public.reject_test_ledger_write();`);
const rejectedLedger = await psql(buildSupabaseMigrationTransaction(candidate));
assert.notEqual(rejectedLedger.code, 0);
assert.match(rejectedLedger.stderr, /SYNTHETIC_LEDGER_WRITE_FAILURE/);
assert.equal(await ok("SELECT count(*) FROM public.release_guard_effects;"), "0");
assert.equal(await ok("SELECT count(*) FROM supabase_migrations.schema_migrations;"), "0");
console.log("Release guard PostgreSQL integration PASS: stored history/hash/null/duplicates, name/version concurrency, SQL/ledger atomic rollback.");
