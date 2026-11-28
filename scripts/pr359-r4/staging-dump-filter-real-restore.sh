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
-- Explicitly revoked PUBLIC function execution plus selected service/browser
-- grants; the production exporter must preserve these exact privileges.
CREATE ROLE service_role NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
-- Reproduce hosted Staging's *creation-time* ACL behavior, not just explicit
-- GRANT/REVOKE on already-created objects. These defaults are per database;
-- the disposable restore starts without them, as a fresh target does.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
 REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 GRANT EXECUTE ON FUNCTIONS TO service_role;
-- Hosted Staging's future public-table defaults grant only service_role;
-- authorized browser SELECT is granted explicitly per application table.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 GRANT ALL ON SEQUENCES TO service_role;
CREATE SCHEMA private;
CREATE SCHEMA powerhub_private;
CREATE SCHEMA auth;
CREATE TABLE auth.pr359_provider_probe(
 id integer PRIMARY KEY,payload text NOT NULL);
CREATE TABLE public.pr359_export_probe(
 id integer PRIMARY KEY,
 payload text NOT NULL,
 amount numeric(12,2) NOT NULL CHECK (amount>=0));
CREATE UNIQUE INDEX pr359_export_payload_uniq
 ON public.pr359_export_probe(payload);
CREATE FUNCTION public.pr359_acl_probe() RETURNS integer
 LANGUAGE sql SECURITY DEFINER AS 'SELECT 359';
-- Mixed hosted-like ACL patterns, including a browser role and sequences:
-- these must survive exact filtered pg_dump, not merely row and index COPY.
CREATE FUNCTION public.pr359_acl_authenticated_probe() RETURNS integer
 LANGUAGE sql AS 'SELECT 360';
REVOKE ALL ON FUNCTION public.pr359_acl_authenticated_probe() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pr359_acl_authenticated_probe() TO authenticated;
CREATE SEQUENCE public.pr359_acl_sequence;
REVOKE ALL ON SEQUENCE public.pr359_acl_sequence FROM PUBLIC;
GRANT USAGE ON SEQUENCE public.pr359_acl_sequence TO anon;
GRANT SELECT ON SEQUENCE public.pr359_acl_sequence TO service_role;
CREATE TABLE public.pr359_acl_public_table(
 id integer PRIMARY KEY, caption text NOT NULL);
ALTER TABLE public.pr359_acl_public_table ENABLE ROW LEVEL SECURITY;
CREATE POLICY pr359_acl_public_select ON public.pr359_acl_public_table
 FOR SELECT TO anon USING (true);
GRANT SELECT ON TABLE public.pr359_acl_public_table TO anon;
REVOKE ALL ON FUNCTION public.pr359_acl_probe() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pr359_acl_probe() TO service_role;
GRANT SELECT ON TABLE public.pr359_export_probe TO authenticated;
GRANT ALL ON TABLE public.pr359_export_probe TO service_role;
-- Exercise all seven categories required by the strict parity checker.
ALTER TABLE public.pr359_export_probe ENABLE ROW LEVEL SECURITY;
CREATE POLICY pr359_fixture_select ON public.pr359_export_probe
 FOR SELECT TO authenticated USING (true);
CREATE FUNCTION public.pr359_acl_trigger() RETURNS trigger
 LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;';
CREATE TRIGGER pr359_acl_probe_trg BEFORE INSERT ON public.pr359_export_probe
 FOR EACH ROW EXECUTE FUNCTION public.pr359_acl_trigger();
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
# The isolated test extracts just the exporter functions, not its prologue.
# Match the real runner's harmless progress API without changing export logic.
r4_progress(){ :; }
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
CREATE SCHEMA private;
CREATE SCHEMA powerhub_private;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA auth;
CREATE TABLE auth.pr359_provider_probe(
 id integer PRIMARY KEY,payload text NOT NULL);
SQL
# Reproduce a target whose creation-time privilege defaults differ from
# Staging, even if the eventual pg_dump contains the intended default ACLs.
cat <<'SQL' | db pr359_export_restored >/dev/null
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
 GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 GRANT EXECUTE ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 GRANT SELECT ON TABLES TO authenticated;
SQL
db postgres < scripts/pr359-r4/staging-privilege-boundary.sql > "$work/privilege-default-source.jsonl"
db pr359_export_restored < scripts/pr359-r4/staging-privilege-boundary.sql > "$work/privilege-default-drift.jsonl"
if node scripts/pr359-r4/check-staging-privilege-boundary.mjs --compare-default-only \
 "$work/privilege-default-source.jsonl" "$work/privilege-default-drift.jsonl" >/dev/null 2>&1; then
 echo 'PR359_LOCAL_DEFAULT_ACL_DRIFT_NEGATIVE_CONTROL_FAILED' >&2; exit 1
fi
db pr359_export_restored < scripts/pr359-r4/bootstrap-local-staging-default-acl.sql >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-privilege-boundary.sql > "$work/privilege-default-ready.jsonl"
node scripts/pr359-r4/check-staging-privilege-boundary.mjs --compare-default-only \
 "$work/privilege-default-source.jsonl" "$work/privilege-default-ready.jsonl" >/dev/null || {
 echo 'PR359_LOCAL_DEFAULT_ACL_BOOTSTRAP_PARITY_FAILED' >&2; exit 1
}
echo PR359_LOCAL_DEFAULT_ACL_PRE_SCHEMA_REPAIR_TEST_PASS
db pr359_export_restored < "$dumpdir/schema.sql" >/dev/null
db pr359_export_restored < "$dumpdir/data.sql" >/dev/null
# Check the exact production seven-category semantic catalog on the local
# source and restored target. A successful count-only restore is insufficient.
# Negative source control: unknown grantee must fail closed, never generate
# a partial permission replay for a drifted source.
cat <<'SQL' | db postgres >/dev/null
CREATE ROLE pr359_unexpected_acl_role NOLOGIN;
GRANT SELECT ON TABLE public.pr359_acl_public_table TO pr359_unexpected_acl_role;
SQL
if db postgres < scripts/pr359-r4/staging-source-object-acl-replay.sql > "$work/invalid-acl-replay.sql" 2>/dev/null; then
 echo PR359_ACL_REPLAY_UNKNOWN_GRANTEE_ACCEPTED >&2; exit 1
fi
cat <<'SQL' | db postgres >/dev/null
REVOKE SELECT ON TABLE public.pr359_acl_public_table FROM pr359_unexpected_acl_role;
DROP ROLE pr359_unexpected_acl_role;
SQL
# Capture exact ACL replay using the production read-only PostgreSQL catalog
# query; this fixture never connects to hosted projects.
db postgres < scripts/pr359-r4/staging-source-object-acl-replay.sql > "$work/source-object-acl-replay.sql"
[[ -s "$work/source-object-acl-replay.sql" ]] || exit 1
db postgres < scripts/pr359-r4/staging-schema-semantic-fingerprint.sql > "$work/semantic-source.jsonl"
db pr359_export_restored < scripts/pr359-r4/staging-schema-semantic-fingerprint.sql > "$work/semantic-restored.jsonl"
# The production checker is intentionally pinned to 2,723 hosted columns, and
# therefore must NOT be used against this tiny synthetic fixture. Compare the
# actual production SQL's seven digests here without weakening hosted guards.
semantic_fixture_equal(){
 node --input-type=module - "$1" "$2" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const parse=path=>{
 const rows=readFileSync(path,'utf8').trim().split(String.fromCharCode(10)).map(JSON.parse);
 assert.equal(rows.length,7,'all seven schema categories must be present');
 const categories=rows.map(r=>r.category).sort();
 assert.deepEqual(categories,['columns','constraints','functions','indexes','policies','relations','triggers']);
 for(const r of rows){
  assert.match(r.sha256,/^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(r.objects)&&r.objects>0);
 }
 return rows.sort((a,b)=>a.category.localeCompare(b.category));
};
assert.deepEqual(parse(process.argv[2]),parse(process.argv[3]),'fixture semantic parity differs');
JS
}
semantic_fixture_equal "$work/semantic-source.jsonl" "$work/semantic-restored.jsonl" || {
 echo PR359_EXPORT_RESTORED_SEMANTIC_ACL_DRIFT >&2; exit 1;
}
# Regression: force a restore-only privilege escalation and prove that the
# source MVCC ACL replay removes it, without modifying the source's privileges.
printf 'GRANT DELETE ON TABLE public.pr359_acl_public_table TO authenticated;\n' | db pr359_export_restored >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-schema-semantic-fingerprint.sql > "$work/semantic-unreconciled.jsonl"
if semantic_fixture_equal "$work/semantic-source.jsonl" "$work/semantic-unreconciled.jsonl" >/dev/null 2>&1; then
 echo PR359_ACL_REPLAY_NEGATIVE_CONTROL_MISSED_ESCALATION >&2; exit 1
fi
{ printf 'BEGIN;\n'; cat "$work/source-object-acl-replay.sql"; printf '\nCOMMIT;\n'; } | db pr359_export_restored >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-schema-semantic-fingerprint.sql > "$work/semantic-replayed.jsonl"
semantic_fixture_equal "$work/semantic-source.jsonl" "$work/semantic-replayed.jsonl" || {
 echo PR359_SOURCE_ATTESTED_ACL_REPLAY_PARITY_FAILED >&2; exit 1
}
echo PR359_SOURCE_ATTESTED_ACL_REPLAY_NEGATIVE_CONTROL_PASS
# Negative controls must catch EXECUTE and SELECT privilege widening.
printf 'GRANT EXECUTE ON FUNCTION public.pr359_acl_probe() TO anon;\n' | db pr359_export_restored >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-schema-semantic-fingerprint.sql > "$work/semantic-escalated.jsonl"
if semantic_fixture_equal "$work/semantic-source.jsonl" "$work/semantic-escalated.jsonl" >/dev/null 2>&1; then
 echo PR359_EXPORT_UNAUTHORIZED_FUNCTION_EXECUTE_ACCEPTED >&2; exit 1;
fi
printf 'REVOKE EXECUTE ON FUNCTION public.pr359_acl_probe() FROM anon;\nGRANT SELECT ON TABLE public.pr359_export_probe TO anon;\n' | db pr359_export_restored >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-schema-semantic-fingerprint.sql > "$work/semantic-escalated.jsonl"
if semantic_fixture_equal "$work/semantic-source.jsonl" "$work/semantic-escalated.jsonl" >/dev/null 2>&1; then
 echo PR359_EXPORT_UNAUTHORIZED_TABLE_READ_ACCEPTED >&2; exit 1;
fi
printf 'REVOKE SELECT ON TABLE public.pr359_export_probe FROM anon;\n' | db pr359_export_restored >/dev/null
[[ "$(printf "SELECT has_function_privilege('anon','public.pr359_acl_probe()','EXECUTE');" | db pr359_export_restored)" == f ]] || exit 1
[[ "$(printf "SELECT has_function_privilege('anon','public.pr359_acl_trigger()','EXECUTE');" | db pr359_export_restored)" == f ]] || {
 echo PR359_EXPORT_DEFAULT_FUNCTION_PUBLIC_EXECUTE_LEAK >&2; exit 1;
}
[[ "$(printf "SELECT has_function_privilege('service_role','public.pr359_acl_probe()','EXECUTE');" | db pr359_export_restored)" == t ]] || exit 1
[[ "$(printf "SELECT has_table_privilege('authenticated','public.pr359_export_probe','SELECT');" | db pr359_export_restored)" == t ]] || exit 1
[[ "$(printf "SELECT has_table_privilege('anon','public.pr359_export_probe','SELECT');" | db pr359_export_restored)" == f ]] || exit 1
# Preserve the separate EXECUTE, RLS SELECT, and SEQUENCE USAGE grants.
[[ "$(printf "SELECT has_function_privilege('authenticated','public.pr359_acl_authenticated_probe()','EXECUTE');" | db pr359_export_restored)" == t ]] || {
 echo PR359_EXPORT_AUTHENTICATED_EXECUTE_MISSING >&2; exit 1;
}
[[ "$(printf "SELECT has_function_privilege('anon','public.pr359_acl_authenticated_probe()','EXECUTE');" | db pr359_export_restored)" == f ]] || {
 echo PR359_EXPORT_AUTHENTICATED_FUNCTION_PUBLIC_LEAK >&2; exit 1;
}
[[ "$(printf "SELECT has_table_privilege('anon','public.pr359_acl_public_table','SELECT');" | db pr359_export_restored)" == t ]] || {
 echo PR359_EXPORT_ANON_SELECT_MISSING >&2; exit 1;
}
[[ "$(printf "SELECT has_sequence_privilege('anon','public.pr359_acl_sequence','USAGE');" | db pr359_export_restored)" == t ]] || {
 echo PR359_EXPORT_SEQUENCE_ANON_USAGE_MISSING >&2; exit 1;
}
[[ "$(printf "SELECT has_sequence_privilege('authenticated','public.pr359_acl_sequence','USAGE');" | db pr359_export_restored)" == f ]] || {
 echo PR359_EXPORT_SEQUENCE_UNAUTHORIZED_AUTHENTICATED_USAGE >&2; exit 1;
}
# Negative control: keep one sequence USAGE grant while swapping its grantee.
# Object/privilege counts alone cannot establish equal authorization.
db postgres < scripts/pr359-r4/staging-schema-semantic-fingerprint.sql > "$work/semantic-role-source.jsonl"
printf 'REVOKE USAGE ON SEQUENCE public.pr359_acl_sequence FROM anon;\nGRANT USAGE ON SEQUENCE public.pr359_acl_sequence TO authenticated;\n' | db pr359_export_restored >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-schema-semantic-fingerprint.sql > "$work/semantic-role-swapped.jsonl"
if semantic_fixture_equal "$work/semantic-role-source.jsonl" "$work/semantic-role-swapped.jsonl" >/dev/null 2>&1; then
 echo PR359_EXPORT_SEQUENCE_GRANTEE_SWAP_ACCEPTED >&2; exit 1;
fi
printf 'REVOKE USAGE ON SEQUENCE public.pr359_acl_sequence FROM authenticated;\nGRANT USAGE ON SEQUENCE public.pr359_acl_sequence TO anon;\n' | db pr359_export_restored >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-schema-semantic-fingerprint.sql > "$work/semantic-role-restored.jsonl"
semantic_fixture_equal "$work/semantic-role-source.jsonl" "$work/semantic-role-restored.jsonl" >/dev/null || {
 echo PR359_EXPORT_SEQUENCE_GRANTEE_ROUNDTRIP_FAILED >&2; exit 1;
}
echo PR359_EXPORT_MIXED_ROLE_FUNCTION_TABLE_SEQUENCE_ACL_PASS
# Capture counts from the exact source/restore grant catalog.
db postgres < scripts/pr359-r4/staging-acl-grant-census.sql > "$work/acl-census-source.jsonl"
db pr359_export_restored < scripts/pr359-r4/staging-acl-grant-census.sql > "$work/acl-census-restored.jsonl"
node scripts/pr359-r4/diagnose-staging-acl-grant-census.mjs --compare \
 "$work/acl-census-source.jsonl" "$work/acl-census-restored.jsonl" >/dev/null
printf 'GRANT EXECUTE ON FUNCTION public.pr359_acl_probe() TO anon;\n' | db pr359_export_restored >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-acl-grant-census.sql > "$work/acl-census-escalated.jsonl"
if node scripts/pr359-r4/diagnose-staging-acl-grant-census.mjs --compare \
 "$work/acl-census-source.jsonl" "$work/acl-census-escalated.jsonl" >/dev/null 2>&1; then
 echo 'PR359_LOCAL_ACL_GRANT_CENSUS_NEGATIVE_CONTROL_FAILED' >&2; exit 1
fi
printf 'REVOKE EXECUTE ON FUNCTION public.pr359_acl_probe() FROM anon;\n' | db pr359_export_restored >/dev/null
echo 'PR359_LOCAL_ACL_GRANT_CENSUS_NEGATIVE_CONTROL_PASS'
echo PR359_EXACT_EXPORT_SEMANTIC_ACL_PARITY_AND_NEGATIVE_CONTROLS_PASS
# Default privileges govern *future* objects and are not represented by
# the seven existing-object catalogs. Check source/target grant provenance and
# default ACLs separately, still using the local-only PostgreSQL instances.
# Only stable role names, namespace names, object types and ACL entries are
# compared; no business data or secrets are exported.
default_acl_sql="SELECT coalesce(jsonb_agg(jsonb_build_object(
 'owner',pg_get_userbyid(d.defaclrole),
 'schema',coalesce(n.nspname,'<global>'),
 'type',d.defaclobjtype,
 'grants',(SELECT coalesce(jsonb_agg(jsonb_build_array(
 pg_get_userbyid(a.grantor),
 CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 a.privilege_type,a.is_grantable)
 ORDER BY pg_get_userbyid(a.grantor),a.grantee,a.privilege_type,a.is_grantable),'[]'::jsonb)
 FROM aclexplode(d.defaclacl) a))
 ORDER BY coalesce(n.nspname,'<global>'),d.defaclobjtype),'[]'::jsonb)::text
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
 WHERE pg_get_userbyid(d.defaclrole)='postgres'
 AND (d.defaclnamespace=0 OR n.nspname='public');"
source_defaults="$(printf '%s\n' "$default_acl_sql" | db postgres)"
target_defaults="$(printf '%s\n' "$default_acl_sql" | db pr359_export_restored)"
[[ -n "$source_defaults" && "$source_defaults" == "$target_defaults" ]] || {
 echo PR359_EXPORT_DEFAULT_ACL_PARITY_FAILED >&2; exit 1;
}
# Negative control: changing privileges for future RPCs must be detected.
printf 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;\n' | db pr359_export_restored >/dev/null
escalated_defaults="$(printf '%s\n' "$default_acl_sql" | db pr359_export_restored)"
[[ "$source_defaults" != "$escalated_defaults" ]] || {
 echo PR359_EXPORT_UNAUTHORIZED_FUTURE_FUNCTION_EXECUTE_ACCEPTED >&2; exit 1;
}
printf 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;\n' | db pr359_export_restored >/dev/null
[[ "$source_defaults" == "$(printf '%s\n' "$default_acl_sql" | db pr359_export_restored)" ]] || {
 echo PR359_EXPORT_DEFAULT_ACL_ROUNDTRIP_FAILED >&2; exit 1;
}
echo PR359_EXACT_EXPORT_DEFAULT_ACL_PARITY_AND_NEGATIVE_CONTROL_PASS
# Security boundary beyond the seven existing-object catalog categories.
db postgres < scripts/pr359-r4/staging-privilege-boundary.sql > "$work/privilege-source.jsonl"
db pr359_export_restored < scripts/pr359-r4/staging-privilege-boundary.sql > "$work/privilege-restored.jsonl"
node scripts/pr359-r4/check-staging-privilege-boundary.mjs --compare \
 "$work/privilege-source.jsonl" "$work/privilege-restored.jsonl" >/dev/null
printf 'GRANT USAGE ON SCHEMA public TO anon;\n' | db pr359_export_restored >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-privilege-boundary.sql > "$work/privilege-escalated.jsonl"
if node scripts/pr359-r4/check-staging-privilege-boundary.mjs --compare \
 "$work/privilege-source.jsonl" "$work/privilege-escalated.jsonl" >/dev/null 2>&1; then
 echo PR359_LOCAL_UNAUTHORIZED_SCHEMA_USAGE_ACCEPTED >&2; exit 1
fi
printf 'REVOKE USAGE ON SCHEMA public FROM anon;\nGRANT SELECT(payload) ON public.pr359_export_probe TO anon;\n' | db pr359_export_restored >/dev/null
db pr359_export_restored < scripts/pr359-r4/staging-privilege-boundary.sql > "$work/privilege-escalated.jsonl"
if node scripts/pr359-r4/check-staging-privilege-boundary.mjs --compare \
 "$work/privilege-source.jsonl" "$work/privilege-escalated.jsonl" >/dev/null 2>&1; then
 echo PR359_LOCAL_UNAUTHORIZED_COLUMN_READ_ACCEPTED >&2; exit 1
fi
printf 'REVOKE SELECT(payload) ON public.pr359_export_probe FROM anon;\n' | db pr359_export_restored >/dev/null
echo PR359_LOCAL_PRIVILEGE_BOUNDARY_NEGATIVE_CONTROLS_PASS
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
