#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.." 
mode="${1:-}"
[[ "$mode" == smoke || "$mode" == full ]] || { echo 'Usage: run.sh smoke|full' >&2; exit 2; }
for tool in docker node sha256sum; do command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 2; }; done
work="$(mktemp -d)"
container=''
cleanup(){ if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || :; fi; rm -rf -- "$work"; }
trap cleanup EXIT
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
start(){
  local image="$1"
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null; fi
  container="pr359-shadow-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  docker run --rm -d --network none --name "$container" -e "POSTGRES_PASSWORD=$password" -e POSTGRES_DB=postgres "$image" >/dev/null
  local ok=0
  for i in $(seq 1 60); do
    if docker exec "$container" pg_isready -h /var/run/postgresql -U postgres -d postgres >/dev/null 2>&1; then ok=1;break;fi
    sleep 1
  done
  [[ "$ok" == 1 ]] || { echo 'Docker postgres did not become ready' >&2; exit 1; }
  [[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container")" == none ]] || exit 1
  [[ -z "$(docker port "$container")" ]] || { echo 'Unexpected published Docker port' >&2; exit 1; }
}
sql(){
  docker exec -i -e "PGPASSWORD=$password" "$container" psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d "${1:-postgres}"
}
runfile(){ sql "$1" < "$2" >/dev/null; }
value(){ printf '%s\n' "$1" | sql postgres | tail -1; }
if [[ "$mode" == smoke ]]; then
  start postgres:17.6
  runfile postgres supabase/tests/pr359_full_legacy_backfill_setup.sql
  for i in 1 2; do
    runfile postgres supabase/migrations/20261103145232_powerhub_legacy_unlinked_payments_to_subscriber_credit.sql
    runfile postgres supabase/tests/pr359_full_legacy_backfill_assert.sql
  done
  docker exec -e "PGPASSWORD=$password" "$container" createdb -U postgres shadow_failure
  runfile shadow_failure supabase/tests/pr359_full_legacy_backfill_setup.sql
  { printf 'BEGIN;\n'; cat supabase/migrations/20261103145232_powerhub_legacy_unlinked_payments_to_subscriber_credit.sql;
    printf "\nDO \$fault\$ BEGIN RAISE EXCEPTION 'PR359_CONTROLLED_DOCKER_FAULT'; END \$fault\$;\nCOMMIT;\n"; } > "$work/fault.sql"
  if sql shadow_failure < "$work/fault.sql" >"$work/fault.log" 2>&1; then echo 'Expected failure missing' >&2;exit 1;fi
  grep -q PR359_CONTROLLED_DOCKER_FAULT "$work/fault.log" || { echo 'Unexpected error before fault boundary' >&2;exit 1; }
  runfile shadow_failure supabase/tests/pr359_full_legacy_backfill_rollback_assert.sql
  echo 'PR359_DOCKER_ISOLATED_SMOKE_PASS'
  exit 0
fi
[[ "${SHADOW_CONFIRM_PRODUCTION_TEST_DATA:-}" == YES_PRODUCTION_TEST_DATA ]] || exit 2
[[ -n "${SHADOW_SOURCE_DB_URL:-}" ]] || { echo 'Missing source secret' >&2;exit 2; }
[[ "$(git rev-parse HEAD)" == "${SHADOW_APPROVED_HEAD:-}" ]] || { echo 'Source HEAD SHA mismatch' >&2;exit 2; }
command -v supabase >/dev/null && command -v psql >/dev/null || { echo 'Missing Supabase CLI or psql' >&2;exit 2; }
node scripts/pr359-shadow/guard.mjs
[[ "$(supabase --version | cut -d. -f1)" == 2 ]] || { echo 'Supabase CLI v2 required' >&2;exit 2; }
mkdir -p "$work/dump" "$work/transactions"
export PGOPTIONS='-c default_transaction_read_only=on' PGSSLMODE=require
source_sql="SELECT jsonb_build_object('payments',(SELECT count(*) FROM public.payments),'invoices',(SELECT count(*) FROM public.invoices),'cash',(SELECT count(*) FROM public.account_transactions),'auth_users',(SELECT count(*) FROM auth.users),'migration_rows',(SELECT count(*) FROM supabase_migrations.schema_migrations))::text;"
if ! psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$SHADOW_SOURCE_DB_URL" --command "$source_sql" > "$work/source-counts" 2>/dev/null; then
  echo 'Read-only source check failed' >&2;exit 1
fi
dump(){
  local output="$1";shift
  if ! supabase db dump --db-url "$SHADOW_SOURCE_DB_URL" -f "$work/dump/$output" "$@" >"$work/dump.log" 2>&1; then
    echo "Supabase logical export failed: $output" >&2; exit 1
  fi
  [[ -s "$work/dump/$output" ]] || { echo "Empty dump: $output" >&2;exit 1; }
}
dump roles.sql --role-only
dump schema.sql
dump data.sql --data-only --use-copy
dump history-schema.sql --schema supabase_migrations
dump history-data.sql --schema supabase_migrations --data-only --use-copy
unset PGOPTIONS SHADOW_SOURCE_DB_URL
node scripts/pr359-shadow/render.mjs "$work/transactions"
image=supabase/postgres:17.6.1.155
restore(){
  start "$image"
  [[ "$(value 'SHOW server_version_num;')" == 17* ]] || exit 1
  runfile postgres "$work/dump/roles.sql"
  runfile postgres "$work/dump/schema.sql"
  { printf 'BEGIN;\nSET LOCAL session_replication_role=replica;\n'; cat "$work/dump/data.sql"; printf '\nCOMMIT;\n'; } > "$work/restore-data.sql"
  runfile postgres "$work/restore-data.sql"
  if [[ "$(value "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL;")" == f ]]; then
    runfile postgres "$work/dump/history-schema.sql"
  fi
  runfile postgres "$work/dump/history-data.sql"
  [[ "$(value "$source_sql")" == "$(cat "$work/source-counts")" ]] || { echo 'Source and restore row counts differ' >&2;exit 1; }
  [[ "$(value "SELECT to_regclass('auth.users') IS NOT NULL AND to_regclass('storage.objects') IS NOT NULL AND to_regclass('supabase_migrations.schema_migrations') IS NOT NULL;")" == t ]] || { echo 'Managed schema missing' >&2;exit 1; }
}
apply(){ for i in $(seq "$1" 4); do runfile postgres "$work/transactions/$i-apply.sql";done; }
fingerprint(){ sql postgres < scripts/pr359-shadow/fingerprint.sql | tail -1; }
restore
apply 1
fingerprint > "$work/first"
restore
apply 1
fingerprint > "$work/second"
cmp -s "$work/first" "$work/second" || { echo 'Independent upgrade fingerprints differ' >&2; exit 1; }
restore
runfile postgres "$work/transactions/1-apply.sql"
if sql postgres < "$work/transactions/2-fault.sql" > "$work/failure.log" 2>&1; then echo 'Expected failure missing' >&2;exit 1;fi
grep -q PR359_DOCKER_SHADOW_EXPECTED_FAILURE "$work/failure.log" || { echo 'Unexpected failure before fault boundary' >&2;exit 1; }
[[ "$(value "SELECT NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20261103131104');")" == t ]] || { echo 'Ledger rollback failed' >&2;exit 1; }
[[ "$(value "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payments' AND column_name='invoice_applied_amount');")" == t ]] || { echo 'Schema rollback failed' >&2;exit 1; }
apply 2
fingerprint > "$work/third"
cmp -s "$work/first" "$work/third" || { echo 'Recovered upgrade differs' >&2;exit 1; }
echo "PR359_DOCKER_FINANCE_REHEARSAL_PASS_SHA=$(git rev-parse HEAD)"
echo "FINANCIAL_FINGERPRINT_SHA256=$(sha256sum "$work/first" | cut -d' ' -f1)"
echo 'MIGRATION_RECONCILIATION_PASS=NOT_GRANTED'
echo 'PRODUCTION_SHADOW_UPGRADE_PASS=NOT_GRANTED_COMPLETE_CROSSWALK_PENDING'
