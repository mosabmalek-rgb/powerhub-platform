#!/usr/bin/env bash
# Characterize concurrent projection ordering with the exact archived Emit and
# the tested indirect refresh candidate. Never connect to a hosted database.
set -euo pipefail
: "${PR359_TEST_CONTAINER:?Missing disposable container}"
: "${PR359_TEST_PASSWORD:?Missing test password}"
[[ "$PR359_TEST_CONTAINER" =~ ^pr359-definer-[0-9a-f]{12}$ ]] || exit 2
[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$PR359_TEST_CONTAINER")" == none ]] || exit 2
[[ -z "$(docker port "$PR359_TEST_CONTAINER")" ]] || exit 2
[[ "$#" == 2 && -f "$1" && -f "$2" ]] || exit 2
db=pr359_indirect_concurrency
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
# Install the already verified generated prefix into a fresh test-only database.
# This is the only path that commits the synthetic fixture, to allow real sessions.
node --input-type=module - "$2" > "$tmp/install.sql" <<'NODE'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const input=readFileSync(process.argv[2],'utf8');
const stop="-- Test-only scale extension, inside the generator's existing guarded transaction.";
assert.equal(input.split(stop).length,2,'scale boundary drift');
let prefix=input.split(stop)[0];
const guard="current_database()<>'pr359_real_capture'";
assert.equal(prefix.split(guard).length,2,'database guard drift');
prefix=prefix.replace(guard,()=> "current_database()<>'pr359_indirect_concurrency'");
assert.ok(prefix.includes('PR359_CANDIDATE_INDIRECT_ROLLBACK_PASS'));
assert.ok(prefix.includes('PR359_CANDIDATE_HISTORICAL_PART_PULL_PASS'));
assert.ok(!/^\s*(COMMIT|ROLLBACK);\s*$/mi.test(prefix));
assert.ok(!/\\connect\b|\\copy\b|dblink|postgres(?:ql)?:\/\//i.test(prefix));
console.log(prefix+'\nCOMMIT;');
NODE
docker exec -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" createdb -U postgres "$db"
db_created=1
run_sql < "$1" > "$tmp/base.txt"
grep -Fxq PR359_REAL_CAPTURE_INVALID_SCOPE_ROLLBACK_PASS "$tmp/base.txt"
run_sql < "$tmp/install.sql" > "$tmp/install.txt"
grep -Fxq PR359_CANDIDATE_INDIRECT_ROLLBACK_PASS "$tmp/install.txt"
baseline="$(run_sql <<'SQL'
SELECT last_cursor FROM public.powerhub_sync_scope_state
WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:98001';
SQL
)"
[[ "$baseline" =~ ^[0-9]+$ ]]
coproc INDIRECT_WRITER { run_sql; }
writer_pid="$INDIRECT_WRITER_PID"
writer_in="${INDIRECT_WRITER[1]}"
writer_out="${INDIRECT_WRITER[0]}"
printf '%s\n' "SET application_name='pr359_indirect_warehouse_a';" "SET statement_timeout='30s';" 'BEGIN;' \
 "UPDATE public.inventory_warehouses SET name='CONCURRENT-WH-A' WHERE tenant_id=1 AND site_id=101 AND id=81;" \
 "SELECT 'PR359_INDIRECT_WAREHOUSE_UNCOMMITTED';" >&"$writer_in"
IFS= read -r -t 25 output <&"$writer_out"
[[ "$output" == PR359_INDIRECT_WAREHOUSE_UNCOMMITTED ]]
# Independent reader must not see A's uncommitted source change or cursor.
run_sql <<SQL > "$tmp/visibility.txt"
SELECT CASE WHEN
 (SELECT name FROM public.inventory_warehouses WHERE tenant_id=1 AND site_id=101 AND id=81)='WH-A-CANDIDATE'
 AND (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:98001')=$baseline
 THEN 'PR359_INDIRECT_UNCOMMITTED_INVISIBLE_PASS' ELSE 'FAILED' END;
SQL
grep -Fxq PR359_INDIRECT_UNCOMMITTED_INVISIBLE_PASS "$tmp/visibility.txt"
{
 printf '%s\n' "SET application_name='pr359_indirect_item_b';" "SET statement_timeout='30s';"
 printf '%s\n' "UPDATE public.inventory_items SET name='CONCURRENT-ITEM-B',category='concurrent-category' WHERE tenant_id=1 AND id=72;"
} | run_sql > "$tmp/b.txt" 2> "$tmp/b.err" &
second_pid="$!"
blocked=0
for i in $(seq 1 60); do
 n="$(run_sql <<'SQL'
SELECT count(*) FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
WHERE b.datname=current_database() AND a.datname=current_database()
AND a.application_name='pr359_indirect_warehouse_a' AND b.application_name='pr359_indirect_item_b'
AND b.wait_event_type='Lock';
SQL
)"
 if [[ "$n" == 1 ]]; then blocked=1; break; fi
 sleep 0.2
done
[[ "$blocked" == 1 ]] || { echo PR359_INDIRECT_EXPECTED_LOCK_MISSING >&2; cat "$tmp/b.err" >&2; exit 1; }
printf 'COMMIT;\n\\q\n' >&"$writer_in"
wait "$writer_pid"
writer_pid=''
wait "$second_pid" || { cat "$tmp/b.err" >&2; exit 1; }
second_pid=''
# Characterization: if the archived Emit projects before serializing, the
# second event carries B's fresh item plus A's old warehouse. Explicitly
# require that mismatch rather than reporting this as a correctness pass.
run_sql > "$tmp/final.txt" <<SQL
DO \$verify\$
DECLARE page jsonb; snap jsonb; first_event jsonb; last_event jsonb;
BEGIN
 page:=public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'maintenance_work_order_parts:98001',$baseline,null,200);
 snap:=public.powerhub_get_fuel_maintenance_sync_snapshot(1,101,'maintenance_work_order_parts:98001');
 first_event:=page->'changes'->0->'row_data';
 last_event:=page->'changes'->1->'row_data';
 IF page->>'status' IS DISTINCT FROM 'ok'
 OR jsonb_array_length(page->'changes') IS DISTINCT FROM 2
 OR page->'changes'->0->>'cursor' IS DISTINCT FROM ($baseline+1)::text
 OR page->'changes'->1->>'cursor' IS DISTINCT FROM ($baseline+2)::text
 OR first_event->>'id' IS DISTINCT FROM '99001'
 OR last_event->>'id' IS DISTINCT FROM '99001'
 OR first_event->>'warehouse_name' IS DISTINCT FROM 'CONCURRENT-WH-A'
 OR first_event->>'item_name' IS DISTINCT FROM 'PART-CANDIDATE'
 OR last_event->>'warehouse_name' IS DISTINCT FROM 'WH-A-CANDIDATE'
 OR last_event->>'item_name' IS DISTINCT FROM 'CONCURRENT-ITEM-B'
 OR snap->>'snapshot_cursor' IS DISTINCT FROM ($baseline+2)::text
 OR snap->'rows'->0->>'warehouse_name' IS DISTINCT FROM 'CONCURRENT-WH-A'
 OR snap->'rows'->0->>'item_name' IS DISTINCT FROM 'CONCURRENT-ITEM-B'
 OR snap->'rows'->0 IS NOT DISTINCT FROM last_event
 THEN RAISE EXCEPTION 'PR359_INDIRECT_CONCURRENT_PROJECTION_CHARACTERIZATION_CHANGED: page=%, snap=%',page,snap; END IF;
END \$verify\$;
SELECT 'PR359_INDIRECT_CONCURRENT_STALE_PROJECTION_CHARACTERIZED';
SELECT 'PR359_INDIRECT_CONCURRENT_PROJECTION_APPROVED=FALSE';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
SQL
for marker in PR359_INDIRECT_CONCURRENT_STALE_PROJECTION_CHARACTERIZED PR359_INDIRECT_CONCURRENT_PROJECTION_APPROVED=FALSE PR359_CANONICAL_BASELINE_APPROVED=FALSE; do
 grep -Fxq "$marker" "$tmp/final.txt"
 echo "$marker"
done
echo PR359_INDIRECT_UNCOMMITTED_INVISIBLE_PASS
echo PR359_INDIRECT_REAL_SCOPE_LOCK_WAIT_PASS
# Install candidate only after the original characterization succeeds.
run_sql < scripts/pr359-canonical/fixtures/emit-lock-before-projection-disposable.sql > "$tmp/emit-install.txt"
for marker in PR359_EMIT_LOCK_BEFORE_PROJECTION_INSTALLED PR359_EMIT_NEW_SCOPE_AND_ROLLBACK_PASS; do
 grep -Fxq "$marker" "$tmp/emit-install.txt"
 echo "$marker"
done
baseline="$(run_sql <<'SQL'
SELECT last_cursor FROM public.powerhub_sync_scope_state
WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:98001';
SQL
)"
[[ "$baseline" =~ ^[0-9]+$ ]]
coproc INDIRECT_WRITER { run_sql; }
writer_pid="$INDIRECT_WRITER_PID"
writer_in="${INDIRECT_WRITER[1]}"
writer_out="${INDIRECT_WRITER[0]}"
printf '%s\n' "SET application_name='pr359_indirect_warehouse_a';" "SET statement_timeout='30s';" 'BEGIN;' \
 "UPDATE public.inventory_warehouses SET name='LOCKED-WH-A' WHERE tenant_id=1 AND site_id=101 AND id=81;" \
 "SELECT 'PR359_INDIRECT_WAREHOUSE_UNCOMMITTED';" >&"$writer_in"
IFS= read -r -t 25 output <&"$writer_out"
[[ "$output" == PR359_INDIRECT_WAREHOUSE_UNCOMMITTED ]]
# Independent reader must not see A's uncommitted source change or cursor.
run_sql <<SQL > "$tmp/visibility.txt"
SELECT CASE WHEN
 (SELECT name FROM public.inventory_warehouses WHERE tenant_id=1 AND site_id=101 AND id=81)='CONCURRENT-WH-A'
 AND (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:98001')=$baseline
 THEN 'PR359_EMIT_LOCKED_UNCOMMITTED_INVISIBLE_PASS' ELSE 'FAILED' END;
SQL
grep -Fxq PR359_EMIT_LOCKED_UNCOMMITTED_INVISIBLE_PASS "$tmp/visibility.txt"
{
 printf '%s\n' "SET application_name='pr359_indirect_item_b';" "SET statement_timeout='30s';"
 printf '%s\n' "UPDATE public.inventory_items SET name='LOCKED-ITEM-B',category='locked-category' WHERE tenant_id=1 AND id=72;"
} | run_sql > "$tmp/b.txt" 2> "$tmp/b.err" &
second_pid="$!"
blocked=0
for i in $(seq 1 60); do
 n="$(run_sql <<'SQL'
SELECT count(*) FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
WHERE b.datname=current_database() AND a.datname=current_database()
AND a.application_name='pr359_indirect_warehouse_a' AND b.application_name='pr359_indirect_item_b'
AND b.wait_event_type='Lock';
SQL
)"
 if [[ "$n" == 1 ]]; then blocked=1; break; fi
 sleep 0.2
done
[[ "$blocked" == 1 ]] || { echo PR359_INDIRECT_EXPECTED_LOCK_MISSING >&2; cat "$tmp/b.err" >&2; exit 1; }
printf 'COMMIT;\n\\q\n' >&"$writer_in"
wait "$writer_pid"
writer_pid=''
wait "$second_pid" || { cat "$tmp/b.err" >&2; exit 1; }
second_pid=''
# Candidate: the second projection must see A's committed warehouse name and B's item.
run_sql > "$tmp/final.txt" <<SQL
DO \$verify\$
DECLARE page jsonb; snap jsonb; first_event jsonb; last_event jsonb;
BEGIN
 page:=public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'maintenance_work_order_parts:98001',$baseline,null,200);
 snap:=public.powerhub_get_fuel_maintenance_sync_snapshot(1,101,'maintenance_work_order_parts:98001');
 first_event:=page->'changes'->0->'row_data';
 last_event:=page->'changes'->1->'row_data';
 IF page->>'status' IS DISTINCT FROM 'ok'
 OR jsonb_array_length(page->'changes') IS DISTINCT FROM 2
 OR page->'changes'->0->>'cursor' IS DISTINCT FROM ($baseline+1)::text
 OR page->'changes'->1->>'cursor' IS DISTINCT FROM ($baseline+2)::text
 OR first_event->>'id' IS DISTINCT FROM '99001'
 OR last_event->>'id' IS DISTINCT FROM '99001'
 OR first_event->>'warehouse_name' IS DISTINCT FROM 'LOCKED-WH-A'
 OR first_event->>'item_name' IS DISTINCT FROM 'CONCURRENT-ITEM-B'
 OR last_event->>'warehouse_name' IS DISTINCT FROM 'LOCKED-WH-A'
 OR last_event->>'item_name' IS DISTINCT FROM 'LOCKED-ITEM-B'
 OR snap->>'snapshot_cursor' IS DISTINCT FROM ($baseline+2)::text
 OR snap->'rows'->0->>'warehouse_name' IS DISTINCT FROM 'LOCKED-WH-A'
 OR snap->'rows'->0->>'item_name' IS DISTINCT FROM 'LOCKED-ITEM-B'
 OR snap->'rows'->0 IS DISTINCT FROM last_event
 OR EXISTS(SELECT 1 FROM public.generator_maintenance_work_order_parts p
 WHERE p.tenant_id=1 AND p.item_id=72
 AND (SELECT c.row_data FROM public.powerhub_sync_changes c
 WHERE c.tenant_id=p.tenant_id AND c.site_id=p.site_id AND c.entity_type='maintenance_work_order_parts:'||p.work_order_id::text
 AND c.entity_id=p.id::text ORDER BY c.cursor DESC LIMIT 1)
 IS DISTINCT FROM public.powerhub_project_maintenance_work_order_part_delta_row(p.tenant_id,p.site_id,p.work_order_id,p.id))
 THEN RAISE EXCEPTION 'PR359_EMIT_LOCKED_CONCURRENT_PROJECTION_FAILED: page=%, snap=%',page,snap; END IF;
END \$verify\$;
SELECT 'PR359_EMIT_LOCKED_CONCURRENT_PROJECTION_PASS';
SELECT 'PR359_EMIT_FULL_CONCURRENCY_CLOSURE_APPROVED=FALSE';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
SQL
for marker in PR359_EMIT_LOCKED_CONCURRENT_PROJECTION_PASS PR359_EMIT_FULL_CONCURRENCY_CLOSURE_APPROVED=FALSE PR359_CANONICAL_BASELINE_APPROVED=FALSE; do
 grep -Fxq "$marker" "$tmp/final.txt"
 echo "$marker"
done
echo PR359_EMIT_LOCKED_UNCOMMITTED_INVISIBLE_PASS
echo PR359_EMIT_LOCKED_REAL_SCOPE_WAIT_PASS
bash scripts/pr359-canonical/cb-a-compound-scope-concurrency-disposable.sh
docker exec -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" dropdb -U postgres "$db"
db_created=0
echo PR359_INDIRECT_CONCURRENCY_DISPOSABLE_DATABASE_REMOVED_PASS
