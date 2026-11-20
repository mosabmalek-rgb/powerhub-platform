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
# A validated FK definition is not sufficient: COPY with replication triggers
# disabled can import orphans. Validate the exact source-audit SQL on local PG.
cat <<'SQL' | db pr359_export_restored >/dev/null
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.powerhub_user_device_locks (
 user_id uuid REFERENCES auth.users(id));
CREATE TABLE public.staff_password_reset_intents (
 auth_user_id uuid REFERENCES auth.users(id));
CREATE TABLE public.users (
 auth_user_id uuid REFERENCES auth.users(id));
INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO public.powerhub_user_device_locks VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO public.staff_password_reset_intents VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO public.users VALUES ('11111111-1111-4111-8111-111111111111');
-- MATCH SIMPLE composite FK: any NULL source component must be accepted.
CREATE TABLE public.pr359_fk_parent (
  branch_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  PRIMARY KEY (branch_id,invoice_id)
);
CREATE TABLE public.pr359_fk_child (
  branch_id bigint,
  invoice_id bigint,
  CONSTRAINT pr359_fk_child_pair_fkey
    FOREIGN KEY (branch_id,invoice_id)
    REFERENCES public.pr359_fk_parent(branch_id,invoice_id)
);
INSERT INTO public.pr359_fk_parent VALUES (4,9);
INSERT INTO public.pr359_fk_child VALUES (4,9),(4,NULL),(NULL,10);
SQL
db pr359_export_restored < scripts/pr359-r4/staging-all-fk-integrity.sql > "$work/all-fk-clean.jsonl"
node --input-type=module - "$work/all-fk-clean.jsonl" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessAllFkIntegrity} from './scripts/pr359-r4/check-staging-all-fk-integrity.mjs';
const clean=readFileSync(process.argv[2],'utf8');
const intact=assessAllFkIntegrity(clean,clean,4);
assert.equal(intact.clean,true);
assert.equal(intact.checked,4);
assert.equal(intact.sourceViolations,0);
JS
db pr359_export_restored < scripts/pr359-r4/staging-managed-fk-orphans.sql > "$work/fk-clean.jsonl"
node scripts/pr359-r4/check-staging-managed-fk-orphans.mjs \
  --compare "$work/fk-clean.jsonl" "$work/fk-clean.jsonl" >/dev/null
# Reproduce a broken restore, never on hosted Staging.
cat <<'SQL' | db pr359_export_restored >/dev/null
BEGIN;
SET LOCAL session_replication_role=replica;
INSERT INTO public.users VALUES ('22222222-2222-4222-8222-222222222222');
-- This fully populated composite key has no matching parent tuple.
INSERT INTO public.pr359_fk_child VALUES (4,10);
COMMIT;
SQL
db pr359_export_restored < scripts/pr359-r4/staging-all-fk-integrity.sql > "$work/all-fk-corrupt.jsonl"
node --input-type=module - "$work/all-fk-clean.jsonl" "$work/all-fk-corrupt.jsonl" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessAllFkIntegrity} from './scripts/pr359-r4/check-staging-all-fk-integrity.mjs';
const a=readFileSync(process.argv[2],'utf8');
const b=readFileSync(process.argv[3],'utf8');
const result=assessAllFkIntegrity(a,b,4);
assert.equal(result.clean,false);
assert.equal(result.restoredViolations,2);
assert.equal(result.drift.length,2);
assert.equal(result.sourceViolations,0);
JS
db pr359_export_restored < scripts/pr359-r4/staging-managed-fk-orphans.sql > "$work/fk-orphan.jsonl"
if node scripts/pr359-r4/check-staging-managed-fk-orphans.mjs \
     --compare "$work/fk-clean.jsonl" "$work/fk-orphan.jsonl" >/dev/null 2>&1; then
 echo 'PR359_R4_FK_ORPHAN_INJECTED_FAILURE_NOT_DETECTED' >&2
 exit 1
fi
echo 'PR359_R4_COMPOSITE_FK_MATCH_SIMPLE_AND_ORPHAN_TEST_PASS'
echo 'PR359_R4_REAL_PG_FK_ORPHAN_NEGATIVE_CONTROL_PASS'
echo 'PR359_R4_ACTUAL_STAGING_PGDUMP_FILTERS_AND_RESTORE_PASS'
echo 'PR359_R4_COMBINED_NATIVE_FILTER_MVCC_SNAPSHOT_PASS'
echo 'PR359_R4_PROVIDER_SCHEMA_EXCLUDED_PROVIDER_ROWS_PRESERVED_PASS'
echo 'PR359_R4_HOSTED_STAGING_RESTORE_NOT_PROVEN'
echo 'PR359_STAGING_INPLACE_GO=FALSE'
