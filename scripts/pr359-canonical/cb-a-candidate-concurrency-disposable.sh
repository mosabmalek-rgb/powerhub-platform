#!/usr/bin/env bash
# Candidate concurrency only in a dedicated networkless disposable database.
set -euo pipefail
: "${PR359_TEST_CONTAINER:?Missing disposable container}"
: "${PR359_TEST_PASSWORD:?Missing test password}"
[[ "$PR359_TEST_CONTAINER" =~ ^pr359-definer-[0-9a-f]{12}$ ]] || exit 2
[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$PR359_TEST_CONTAINER")" == none ]] || exit 2
[[ -z "$(docker port "$PR359_TEST_CONTAINER")" ]] || exit 2
[[ "$#" == 1 && -f "$1" ]] || exit 2
cd "$(dirname "$0")/../.."
db=pr359_candidate_concurrency
tmp="$(mktemp -d)"
writer_pid=''; writer_in=''; second_pid=''; db_created=0
cleanup(){
 if [[ -n "$writer_pid" ]]; then
  printf 'ROLLBACK;\n\\q\n' >&"$writer_in" 2>/dev/null || :
  kill "$writer_pid" 2>/dev/null || :
  wait "$writer_pid" 2>/dev/null || :
 fi
 if [[ -n "$second_pid" ]]; then
  kill "$second_pid" 2>/dev/null || :
  wait "$second_pid" 2>/dev/null || :
 fi
 if [[ "$db_created" == 1 ]]; then
  docker exec -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" dropdb --force -U postgres "$db" >/dev/null || :
 fi
 rm -rf "$tmp"
}
trap cleanup EXIT
run_sql(){
 docker exec -i -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -U postgres -d "$db"
}
docker exec -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" createdb -U postgres "$db"
db_created=1
run_sql < "$1" > "$tmp/setup.txt"
grep -Fxq PR359_REAL_APPEND_DISTINCT_SCOPES_PASS "$tmp/setup.txt"
node --input-type=module - > "$tmp/install.sql" <<'NODE'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const text=readFileSync('scripts/pr359-canonical/fixtures/append-payload-candidate-disposable.sql','utf8');
const start='DO $candidate$',end='END $candidate$;';
assert.equal(text.split(start).length,2);
assert.equal(text.split(end).length,2);
const block=text.slice(text.indexOf(start),text.indexOf(end)+end.length);
assert.ok(block.includes('PR359_CANDIDATE_ARCHIVE_ANCHOR_DRIFT'));
assert.ok(block.includes('PR359_CANDIDATE_PAYLOAD_INVALID'));
console.log("BEGIN;\nDO $guard$ BEGIN IF current_database()<>'pr359_candidate_concurrency' THEN RAISE EXCEPTION 'PR359_DISPOSABLE_DATABASE_REQUIRED'; END IF; END $guard$;");
console.log('CREATE TABLE public.generator_maintenance_work_orders(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);');
console.log(block);
console.log('COMMIT;');
NODE
run_sql < "$tmp/install.sql" >/dev/null
append_sql(){
 local tenant="$1" site="$2" id="$3"
 printf "SELECT public.powerhub_append_fuel_maintenance_delta_sync_change(%s,%s,'fuel_events','%s','upsert','{\"id\":%s,\"tenant_id\":%s,\"site_id\":%s}'::jsonb);\n" "$tenant" "$site" "$id" "$id" "$tenant" "$site"
}
phase(){
 local action="$1" baseline="$2" a_id="$3" b_id="$4" other_id="$5" other_cursor="$6" expected_b="$7"
 local output n blocked=0
 coproc CANDIDATE_WRITER { run_sql; }
 writer_pid="$CANDIDATE_WRITER_PID"
 writer_in="${CANDIDATE_WRITER[1]}"
 local writer_out="${CANDIDATE_WRITER[0]}"
 {
  printf '%s\n' "SET application_name='pr359_candidate_writer_a';" "SET statement_timeout='25s';" 'BEGIN;'
  append_sql 1 101 "$a_id"
  printf "%s\n" "SELECT 'PR359_CANDIDATE_WRITER_A_UNCOMMITTED';"
 } >&"$writer_in"
 IFS= read -r -t 25 output <&"$writer_out"
 [[ "$output" == "$((baseline+1))" ]]
 IFS= read -r -t 25 output <&"$writer_out"
 [[ "$output" == PR359_CANDIDATE_WRITER_A_UNCOMMITTED ]]
 output="$(printf "%s\n" "SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events';" | run_sql)"
 [[ "$output" == "$baseline" ]]
 {
  printf '%s\n' "SET application_name='pr359_candidate_writer_b';" "SET statement_timeout='25s';"
  append_sql 1 101 "$b_id"
 } | run_sql > "$tmp/b-$action.txt" 2> "$tmp/b-$action.err" &
 second_pid="$!"
 for i in $(seq 1 60); do
  n="$(printf '%s\n' "SELECT count(*) FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid)) WHERE b.datname=current_database() AND a.datname=current_database() AND a.application_name='pr359_candidate_writer_a' AND b.application_name='pr359_candidate_writer_b' AND b.wait_event_type='Lock';" | run_sql)"
  if [[ "$n" == 1 ]]; then blocked=1; break; fi
  sleep 0.2
 done
 [[ "$blocked" == 1 ]] || { echo PR359_CANDIDATE_EXPECTED_ROW_LOCK_MISSING >&2; exit 1; }
 output="$({ printf "%s\n" "SET statement_timeout='5s';"; append_sql 2 201 "$other_id"; } | run_sql)"
 [[ "$output" == "$other_cursor" ]]
 run_sql <<'SQL' >/dev/null
SET statement_timeout='5s';
DO $reject$
BEGIN
 BEGIN
  PERFORM public.powerhub_append_fuel_maintenance_delta_sync_change(1,101,'fuel_events','96999','upsert','{"id":96999,"tenant_id":2,"site_id":101}'::jsonb);
  RAISE EXCEPTION 'PR359_INVALID_PAYLOAD_WAS_ACCEPTED';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'PR359_CANDIDATE_PAYLOAD_INVALID' THEN RAISE; END IF;
 END;
END $reject$;
SQL
 printf '%s\n' "$action;" '\q' >&"$writer_in"
 wait "$writer_pid"
 writer_pid=''
 wait "$second_pid" || { cat "$tmp/b-$action.err" >&2; exit 1; }
 second_pid=''
 grep -Fxq "$expected_b" "$tmp/b-$action.txt"
}
phase COMMIT 1 96001 96002 96003 2 3
phase ROLLBACK 3 96004 96005 96006 3 4
run_sql > "$tmp/final.txt" <<'SQL'
DO $verify$
BEGIN
 IF (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events') IS DISTINCT FROM 4::bigint
 OR (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=2 AND site_id=201 AND entity_type='fuel_events') IS DISTINCT FROM 3::bigint
 OR (SELECT array_agg(cursor ORDER BY cursor) FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events') IS DISTINCT FROM ARRAY[1,2,3,4]::bigint[]
 OR (SELECT array_agg(cursor ORDER BY cursor) FROM public.powerhub_sync_changes WHERE tenant_id=2 AND site_id=201 AND entity_type='fuel_events') IS DISTINCT FROM ARRAY[1,2,3]::bigint[]
 OR (SELECT array_agg(entity_id ORDER BY cursor) FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events' AND cursor>1) IS DISTINCT FROM ARRAY['96001','96002','96005']::text[]
 OR (SELECT array_agg(entity_id ORDER BY cursor) FROM public.powerhub_sync_changes WHERE tenant_id=2 AND site_id=201 AND entity_type='fuel_events' AND cursor>1) IS DISTINCT FROM ARRAY['96003','96006']::text[]
 OR EXISTS(SELECT 1 FROM public.powerhub_sync_changes WHERE entity_id IN ('96004','96999'))
 OR EXISTS(SELECT 1 FROM public.powerhub_sync_changes WHERE entity_id IN ('96001','96002','96003','96005','96006') AND (row_data->>'tenant_id' IS DISTINCT FROM tenant_id::text OR row_data->>'site_id' IS DISTINCT FROM site_id::text))
 OR (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_orders') IS DISTINCT FROM 1::bigint
 OR public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'fuel_events',1,4,200)->>'status' IS DISTINCT FROM 'ok'
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_CONCURRENCY_JOURNAL_MISMATCH'; END IF;
END $verify$;
SELECT 'PR359_CANDIDATE_SAME_SCOPE_COMMIT_ORDER_PASS';
SELECT 'PR359_CANDIDATE_ROLLBACK_CURSOR_REUSE_PASS';
SELECT 'PR359_CANDIDATE_DISTINCT_SCOPE_AND_REJECTION_PASS';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
SQL
for marker in PR359_CANDIDATE_SAME_SCOPE_COMMIT_ORDER_PASS PR359_CANDIDATE_ROLLBACK_CURSOR_REUSE_PASS PR359_CANDIDATE_DISTINCT_SCOPE_AND_REJECTION_PASS PR359_CANONICAL_BASELINE_APPROVED=FALSE; do
 grep -Fxq "$marker" "$tmp/final.txt"
 echo "$marker"
done
docker exec -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" dropdb -U postgres "$db"
db_created=0
echo PR359_CANDIDATE_CONCURRENCY_DISPOSABLE_DATABASE_REMOVED_PASS
