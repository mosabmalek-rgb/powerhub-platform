#!/usr/bin/env bash
# Exact staging-atomic-export.sh dump functions under real, networkless PG17.
# No hosted database, account or source connection can be used by this test.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
for cmd in docker node od; do command -v "$cmd" >/dev/null || exit 2; done
for forbidden in SHADOW_SOURCE_DB_URL SUPABASE_DB_URL DATABASE_URL SUPABASE_ACCESS_TOKEN; do
  if [[ -n "$(printenv "$forbidden" 2>/dev/null || :)" ]]; then
    echo 'PR359_EXPORT_FIXTURE_HOSTED_CREDENTIAL_FORBIDDEN' >&2
    exit 2
  fi
done
work="$(mktemp -d)"
container="pr359-real-export-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
keeper_pid=''
keeper_in=''
cleanup(){
 if [[ -n "$keeper_in" ]]; then printf 'ROLLBACK;\n\\q\n' >&"$keeper_in" 2>/dev/null || :; fi
 if [[ -n "$keeper_pid" ]]; then kill "$keeper_pid" 2>/dev/null || :; wait "$keeper_pid" 2>/dev/null || :; fi
 docker rm -f "$container" >/dev/null 2>&1 || :
 rm -rf -- "$work"
}
trap cleanup EXIT
docker run --rm -d --network none --name "$container" \
 -e "POSTGRES_PASSWORD=$password" -e POSTGRES_DB=postgres postgres:17.6 >/dev/null
ready=0
for i in $(seq 1 90); do
 if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then ready=1;break;fi
 sleep 1
done
[[ "$ready" == 1 ]] || { echo PR359_REAL_EXPORT_DB_NOT_READY >&2; exit 1; }
[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container")" == none ]] || exit 1
[[ -z "$(docker port "$container")" ]] || exit 1
db(){
 local name="$1"; shift
 docker exec -i -e "PGPASSWORD=$password" "$container" \
   psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d "$name" "$@"
}
cat <<'SQL' | db postgres >/dev/null
CREATE SCHEMA auth;
CREATE TABLE auth.pr359_provider_probe(
 id integer PRIMARY KEY,payload text NOT NULL);
CREATE TABLE public.pr359_export_probe(
 id integer PRIMARY KEY,
 payload text NOT NULL,
 amount numeric(12,2) NOT NULL CHECK (amount>=0));
CREATE UNIQUE INDEX pr359_export_payload_uniq
 ON public.pr359_export_probe(payload);
INSERT INTO public.pr359_export_probe VALUES
 (1,'test-one',12.50),(2,'test-two',0);
INSERT INTO auth.pr359_provider_probe VALUES(1,'test-provider');
SQL
# Export a single MVCC snapshot and keep its transaction open across the dumps.
coproc SNAPSHOT_KEEPER {
 docker exec -i -e "PGPASSWORD=$password" "$container" \
  psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres 2>"$work/keeper.err"
}
keeper_pid="$SNAPSHOT_KEEPER_PID"
keeper_out="${SNAPSHOT_KEEPER[0]}"
keeper_in="${SNAPSHOT_KEEPER[1]}"
printf 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&"$keeper_in"
snapshot=''
if ! IFS= read -r -t 30 snapshot <&"$keeper_out" || [[ ! "$snapshot" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+$ ]]; then
 echo 'PR359_REAL_EXPORT_SNAPSHOT_KEEPER_FAILED' >&2; exit 1
fi

# Evaluate the ACTUAL schema/data export functions and filters. In the test
# only, redirect their pg_dump wrapper to the Docker internal socket.
node - "$work/export-functions.sh" <<'JS'
const fs=require('node:fs');
const source=fs.readFileSync('scripts/pr359-r4/staging-atomic-export.sh','utf8');
const start=source.indexOf("internal='");
const end=source.indexOf('\ndump_schema schema.sql',start);
if(start<0||end<start)throw Error('PR359_EXPORT_FUNCTION_EXTRACTION_FAILED');
const script=source.slice(start,end);
for(const required of ['schema_filter(){','dump_schema(){','dump_data(){','data_excluded=']){
 if(!script.includes(required))throw Error('PR359_EXPORT_FUNCTION_MISSING:'+required);
}
fs.writeFileSync(process.argv[2],script+'\n',{mode:0o600});
JS
mkdir -m 700 "$work/dump"
dumpdir="$work/dump"
# shellcheck disable=SC1090
source "$work/export-functions.sh"
pgdump(){
 docker exec -e "PGPASSWORD=$password" "$container" \
   pg_dump -w -U postgres -d postgres --snapshot="$snapshot" "$@"
}
dump_schema schema.sql "${schema_exclude_args[@]}"
# Concurrent writer commits after schema dump but before data dump.
cat <<'SQL' | db postgres >/dev/null
INSERT INTO public.pr359_export_probe VALUES (3,'late-test',99.99);
UPDATE auth.pr359_provider_probe SET payload='late-provider' WHERE id=1;
SQL
docker exec -e "PGPASSWORD=$password" "$container" pg_dump -w -U postgres -d postgres \
 --data-only --table=public.pr359_export_probe --column-inserts > "$work/fresh.sql"
grep -q 'late-test' "$work/fresh.sql" || { echo 'PR359_NEGATIVE_CONTROL_FAILED' >&2; exit 1; }
dump_data data.sql "${data_exclude_args[@]}" --schema='*'
[[ -s "$dumpdir/schema.sql" && -s "$dumpdir/data.sql" ]] || exit 1
if grep -Eq 'CREATE TABLE (IF NOT EXISTS )?"auth"\."pr359_provider_probe"' "$dumpdir/schema.sql"; then
 echo 'PR359_REAL_EXPORT_MANAGED_SCHEMA_EXCLUSION_FAILED' >&2
 exit 1
fi
grep -Eq 'CREATE TABLE (IF NOT EXISTS )?"public"\."pr359_export_probe"' "$dumpdir/schema.sql" || {
 echo 'PR359_REAL_EXPORT_APP_SCHEMA_MISSING' >&2; exit 1;
}
grep -q 'test-provider' "$dumpdir/data.sql" || {
 echo 'PR359_REAL_EXPORT_PROVIDER_ROW_DATA_EXCLUDED' >&2; exit 1;
}
grep -q 'test-one' "$dumpdir/data.sql" || exit 1
grep -q 'test-two' "$dumpdir/data.sql" || exit 1
if grep -Eq 'late-test|late-provider' "$dumpdir/data.sql"; then
 echo 'PR359_SNAPSHOT_CONCURRENT_ROW_LEAK' >&2; exit 1;
fi

docker exec "$container" createdb -U postgres pr359_export_restored
cat <<'SQL' | db pr359_export_restored >/dev/null
CREATE SCHEMA auth;
CREATE TABLE auth.pr359_provider_probe(
 id integer PRIMARY KEY,payload text NOT NULL);
SQL
db pr359_export_restored < "$dumpdir/schema.sql" >/dev/null
db pr359_export_restored < "$dumpdir/data.sql" >/dev/null
result="$(printf '%s\n' \
 "SELECT (SELECT count(*) FROM public.pr359_export_probe)::text||':'||" \
 "(SELECT sum(amount) FROM public.pr359_export_probe)::text||':'||" \
 "(SELECT count(*) FROM auth.pr359_provider_probe)::text||':'||" \
 "(SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='pr359_export_payload_uniq'))::text;" \
 | db pr359_export_restored)"
[[ "$result" == '2:12.50:1:true' ]] || {
 echo 'PR359_REAL_EXPORT_RESTORED_SCHEMA_OR_ROW_DRIFT' >&2;exit 1;
}
echo 'PR359_R4_ACTUAL_STAGING_PGDUMP_FILTERS_AND_RESTORE_PASS'
echo 'PR359_R4_COMBINED_NATIVE_FILTER_MVCC_SNAPSHOT_PASS'
echo 'PR359_R4_PROVIDER_SCHEMA_EXCLUDED_PROVIDER_ROWS_PRESERVED_PASS'
echo 'PR359_R4_HOSTED_STAGING_RESTORE_NOT_PROVEN'
echo 'PR359_STAGING_INPLACE_GO=FALSE'
