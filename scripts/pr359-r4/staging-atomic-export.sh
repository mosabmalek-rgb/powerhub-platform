#!/usr/bin/env bash
# Staging-only read-only MVCC snapshot, pinned to Supabase CLI v3.2.0 dump filters.
set -euo pipefail
umask 077
[[ "${SHADOW_SOURCE_KIND:-}" == staging && "${SHADOW_REQUIRE_SESSION_POOLER:-}" == true ]] || { echo PR359_STAGING_SNAPSHOT_SOURCE_GUARD_FAILED >&2; exit 2; }
[[ $# == 2 && -d "$1" && -d "$2" && -n "${SOURCE_COUNTS_SQL:-}" ]] || exit 2
for cmd in docker psql node sha256sum; do command -v "$cmd" >/dev/null || exit 2; done
node scripts/pr359-shadow/guard.mjs >/dev/null
dumpdir="$(cd "$1" && pwd)"
workdir="$(cd "$2" && pwd)"
[[ "$dumpdir" == "$workdir"/dump && -s "$dumpdir/roles.sql" ]] || exit 2
export PGSSLMODE=require PGOPTIONS='-c default_transaction_read_only=on'
snapshot=''
keeper_pid=''
keeper_in=''
cleanup(){
 if [[ -n "$keeper_in" ]]; then printf 'ROLLBACK;\n\\q\n' >&"$keeper_in" 2>/dev/null || :; fi
 if [[ -n "$keeper_pid" ]]; then kill "$keeper_pid" 2>/dev/null || :; wait "$keeper_pid" 2>/dev/null || :; fi
}
trap cleanup EXIT
coproc SNAPSHOT_KEEPER { psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" 2>"$workdir/snapshot-keeper.err"; }
keeper_pid="$SNAPSHOT_KEEPER_PID"
keeper_out="${SNAPSHOT_KEEPER[0]}"
keeper_in="${SNAPSHOT_KEEPER[1]}"
printf 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL idle_in_transaction_session_timeout=0;\nSELECT pg_export_snapshot();\n' >&"$keeper_in"
if ! IFS= read -r -t 45 snapshot <&"$keeper_out" || [[ ! "$snapshot" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+$ ]]; then
 echo PR359_STAGING_SNAPSHOT_EXPORT_FAILED >&2; exit 1
fi
export PR359_SNAPSHOT_ID="$snapshot"
source_psql(){
 local output="$1"; shift
 {
  printf "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT '%s';\n" "$snapshot"
  if [[ "$1" == --sql ]]; then printf '%s\n' "$SOURCE_COUNTS_SQL"
  else sed -e '/^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;$/d' -e '/^COMMIT;$/d' "$1"
  fi
  printf '\nCOMMIT;\n'
 } | psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" >"$output" 2>"$workdir/snapshot-query.err" || {
  echo PR359_STAGING_SNAPSHOT_ATTESTATION_FAILED >&2; exit 1;
 }
 [[ -s "$output" ]] || exit 1
}
source_psql "$workdir/source-counts" --sql
source_psql "$workdir/source-history-attestation.json" scripts/pr359-shadow/history-attestation.sql
node scripts/pr359-r4/check-staging-legacy-ledger.mjs "$workdir/source-history-attestation.json"
source_psql "$workdir/staging-tables-source.jsonl" scripts/pr359-r4/staging-table-counts.sql
node scripts/pr359-r4/check-staging-table-counts.mjs --compare "$workdir/staging-tables-source.jsonl" "$workdir/staging-tables-source.jsonl"
source_psql "$workdir/staging-content-source.jsonl" scripts/pr359-r4/staging-table-content.sql
node scripts/pr359-r4/check-staging-table-content.mjs --compare "$workdir/staging-content-source.jsonl" "$workdir/staging-content-source.jsonl"
pgdump(){
 docker run --rm --network host -e SHADOW_SOURCE_DB_URL -e PR359_SNAPSHOT_ID \
   -e PGSSLMODE=require -e PGOPTIONS --entrypoint /bin/sh postgres:17.6 -ec \
   'exec pg_dump --dbname="$SHADOW_SOURCE_DB_URL" --snapshot="$PR359_SNAPSHOT_ID" "$@"' -- "$@" \
   2>"$workdir/snapshot-pgdump.err"
}
internal='information_schema|pg_*|_analytics|_realtime|_supavisor|auth|etl|extensions|pgbouncer|realtime|storage|supabase_functions|supabase_migrations|cron|dbdev|graphql|graphql_public|net|pgmq|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault'
data_excluded='information_schema|pg_*|graphql|graphql_public|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault|etl|extensions|pgbouncer|realtime|supabase_migrations|_analytics|_realtime|_supavisor'
schema_filter(){
 sed -E 's/^\\(un)?restrict .*$/-- &/' |
 sed -E 's/^CREATE SCHEMA "/CREATE SCHEMA IF NOT EXISTS "/' |
 sed -E 's/^CREATE TABLE "/CREATE TABLE IF NOT EXISTS "/' |
 sed -E 's/^CREATE SEQUENCE "/CREATE SEQUENCE IF NOT EXISTS "/' |
 sed -E 's/^CREATE VIEW "/CREATE OR REPLACE VIEW "/' |
 sed -E 's/^CREATE FUNCTION "/CREATE OR REPLACE FUNCTION "/' |
 sed -E 's/^CREATE TRIGGER "/CREATE OR REPLACE TRIGGER "/' |
 sed -E 's/^CREATE PUBLICATION "supabase_realtime/-- &/' |
 sed -E 's/^CREATE EVENT TRIGGER /-- &/' |
 sed -E 's/^         WHEN TAG IN /-- &/' |
 sed -E 's/^   EXECUTE FUNCTION /-- &/' |
 sed -E 's/^ALTER EVENT TRIGGER /-- &/' |
 sed -E 's/^ALTER PUBLICATION "supabase_realtime_/-- &/' |
 sed -E 's/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /-- &/' |
 sed -E 's/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- &/' |
 sed -E 's/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/-- &/' |
 sed -E "s/^GRANT (.+) ON (.+) \"($internal)\"/-- &/" |
 sed -E "s/^REVOKE (.+) ON (.+) \"($internal)\"/-- &/" |
 sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/\1;/' |
 sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/\1;/' |
 sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/\1;/' |
 sed -E 's/^COMMENT ON EXTENSION (.+)/-- &/' |
 sed -E 's/^CREATE POLICY "cron_job_/-- &/' |
 sed -E 's/^ALTER TABLE "cron"/-- &/' |
 sed -E 's/^SET transaction_timeout = 0;/-- &/' |
 sed -E '/^--/d'
}
dump_schema(){
 local output="$1"; shift
 if ! pgdump --schema-only --quote-all-identifiers --role postgres "$@" | schema_filter >"$dumpdir/$output"; then
   echo "PR359_STAGING_ATOMIC_SCHEMA_DUMP_FAILED=$output" >&2; exit 1
 fi
 [[ -s "$dumpdir/$output" ]] || exit 1
}
dump_data(){
 local output="$1"; shift
 { printf 'SET session_replication_role = replica;\n\n'
   pgdump --data-only --quote-all-identifiers --role postgres \
      --exclude-table=auth.schema_migrations --exclude-table=storage.migrations \
      --exclude-table=supabase_functions.migrations "$@" | sed -E 's/^\\(un)?restrict .*$/-- &/'
   printf '\nRESET ALL;\n'
 } >"$dumpdir/$output" || { echo "PR359_STAGING_ATOMIC_DATA_DUMP_FAILED=$output" >&2; exit 1; }
 [[ -s "$dumpdir/$output" ]] || exit 1
}
dump_schema schema.sql --exclude-schema="$internal"
dump_data data.sql --exclude-schema="$data_excluded" --schema='*'
dump_schema history-schema.sql --schema=supabase_migrations
dump_data history-data.sql --schema=supabase_migrations
source_psql "$workdir/staging-content-after-export.jsonl" scripts/pr359-r4/staging-table-content.sql
node scripts/pr359-r4/check-staging-table-content.mjs --compare "$workdir/staging-content-source.jsonl" "$workdir/staging-content-after-export.jsonl"
sha256sum "$dumpdir/roles.sql" "$dumpdir/schema.sql" "$dumpdir/data.sql" \
 "$dumpdir/history-schema.sql" "$dumpdir/history-data.sql" >"$workdir/staging-export-manifest.sha256"
sha256sum -c --status "$workdir/staging-export-manifest.sha256"
echo PR359_STAGING_SHARED_PG_SNAPSHOT_EXPORT_PASS
echo PR359_STAGING_ROLES_CROSS_DUMP_ATOMICITY_NOT_PROVEN
echo PR359_STAGING_INPLACE_GO=FALSE
