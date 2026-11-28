import { buildSupabaseMigrationLedgerInsert } from "./supabase-migration-target.mjs";

/** Recheck both identities under the same lock as the SQL and ledger write. */
export function buildSupabaseMigrationTransaction({ version, name, sql }) {
  // Validate identifiers before interpolating them into the guard.
  const insert = buildSupabaseMigrationLedgerInsert({ version, name, sql });
  return `
BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT pg_advisory_xact_lock(hashtextextended('powerhub:supabase:migration-release:v1', 0));
DO $powerhub_release_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '${version}') THEN
    RAISE EXCEPTION 'POWERHUB_MIGRATION_VERSION_RACE';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '${name}') THEN
    RAISE EXCEPTION 'POWERHUB_MIGRATION_NAME_RACE';
  END IF;
END
$powerhub_release_guard$;
${sql}
${insert}
COMMIT;
`;
}
