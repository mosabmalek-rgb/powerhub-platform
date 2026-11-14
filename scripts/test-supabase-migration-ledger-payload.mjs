import { spawnSync } from "node:child_process";
import {
  buildSupabaseMigrationLedgerInsert,
  computeSupabaseMigrationContentSha256,
} from "./supabase-migration-target.mjs";

const requiredEnvironment = ["PGHOST", "PGPORT", "PGUSER", "PGDATABASE"];
for (const name of requiredEnvironment) {
  if (!process.env[name]?.trim()) {
    throw new Error("Missing PostgreSQL integration-test environment variable: " + name);
  }
}
if (!/^\d+$/.test(process.env.PGPORT)) {
  throw new Error("PGPORT must be numeric.");
}

// Deliberately exceed Linux's 128 KiB per-argument boundary once Base64
// encoding and SQL framing are included. The payload also covers UTF-8,
// SQL quotes, literal backslashes, mixed LF/CRLF and a final newline.
const sql =
  "-- PowerHub migration-ledger payload round-trip: مرحبا\r\n" +
  "-- large source payload: " + "x".repeat(120_000) + "\r\n" +
  "SELECT 'quoted: ''single quote''; backslash: \\\\';\n" +
  "SELECT 'LF line';\r\n" +
  "-- final source line\r\n";

const version = "20991231235959";
const name = "powerhub_migration_ledger_payload_round_trip";
const sqlBase64 = Buffer.from(sql, "utf8").toString("base64");
const expectedSha = computeSupabaseMigrationContentSha256(sql);
const insert = buildSupabaseMigrationLedgerInsert({ version, name, sql });

const query = [
  "BEGIN;",
  "CREATE SCHEMA extensions;",
  "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;",
  "CREATE SCHEMA supabase_migrations;",
  "CREATE TABLE supabase_migrations.schema_migrations (",
  "  version text PRIMARY KEY,",
  "  name text NOT NULL,",
  "  statements text[]",
  ");",
  insert,
  "DO $powerhub_payload_assert$",
  "DECLARE",
  "  expected_sql text := convert_from(decode('" + sqlBase64 + "', 'base64'), 'UTF8');",
  "  actual_sql text;",
  "  actual_statements text[];",
  "BEGIN",
  "  SELECT statements, array_to_string(statements, E'\\n')",
  "    INTO actual_statements, actual_sql",
  "  FROM supabase_migrations.schema_migrations",
  "  WHERE version = '" + version + "' AND name = '" + name + "';",
  "  IF actual_statements IS NULL OR cardinality(actual_statements) <> 1 THEN",
  "    RAISE EXCEPTION 'MIGRATION_LEDGER_PAYLOAD_ARRAY_SHAPE_MISMATCH';",
  "  END IF;",
  "  IF actual_statements[1] IS DISTINCT FROM expected_sql",
  "     OR actual_sql IS DISTINCT FROM expected_sql THEN",
  "    RAISE EXCEPTION 'MIGRATION_LEDGER_PAYLOAD_UTF8_ROUND_TRIP_MISMATCH';",
  "  END IF;",
  "  IF encode(extensions.digest(convert_to(actual_sql, 'UTF8'), 'sha256'), 'hex') IS DISTINCT FROM '" + expectedSha + "' THEN",
  "    RAISE EXCEPTION 'MIGRATION_LEDGER_PAYLOAD_SHA256_MISMATCH';",
  "  END IF;",
  "END",
  "$powerhub_payload_assert$;",
  "ROLLBACK;",
  "SELECT 'POWERHUB_MIGRATION_LEDGER_PAYLOAD_POSTGRES_ROUND_TRIP_OK';",
].join("\n");

const args = [
  "--no-psqlrc",
  "--no-password",
  "--set=ON_ERROR_STOP=1",
  "--tuples-only",
  "--no-align",
  "--host", process.env.PGHOST,
  "--port", process.env.PGPORT,
  "--username", process.env.PGUSER,
  "--dbname", process.env.PGDATABASE,
];
const result = spawnSync("psql", args, {
  input: query,
  encoding: "utf8",
  env: process.env,
  maxBuffer: 1024 * 1024,
});

if (result.error || result.status !== 0) {
  const detail = (result.stderr || result.error?.message || "psql integration assertion failed")
    .trim()
    .slice(-3000);
  throw new Error("PostgreSQL migration-ledger payload integration failed: " + detail);
}

if (!result.stdout.includes("POWERHUB_MIGRATION_LEDGER_PAYLOAD_POSTGRES_ROUND_TRIP_OK")) {
  throw new Error("PostgreSQL did not return the migration-ledger round-trip success marker.");
}

console.log("PostgreSQL 17 preserved a >128 KiB UTF-8 migration SQL payload and SHA-256 over stdin.");
