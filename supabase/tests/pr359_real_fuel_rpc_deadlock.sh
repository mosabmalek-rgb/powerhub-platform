#!/usr/bin/env bash
# Disposable CI fixture only. Actual issue-based fuel fill RPCs, no injected SQLSTATE.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${PGPASSWORD:-}" == postgres && "$#" == 0 ]] || exit 2
db=maintenance_phase_c_test
tmp="$(mktemp -d)"
a_pid=''; b_pid=''
cleanup() {
  for pid in "$a_pid" "$b_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :; fi
  done
  rm -rf "$tmp"
}
trap cleanup EXIT
run_sql() {
  psql -X -w -qAt -h 127.0.0.1 -p 5432 -U postgres -d "$db" -v ON_ERROR_STOP=1 -v VERBOSITY=verbose
}
run_sql <<'SQL' > "$tmp/seed"
DO $guard$
BEGIN
 IF current_database()<>'maintenance_phase_c_test'
 OR to_regprocedure('public.powerhub_inventory_record_fuel_fill(bigint,bigint,bigint,bigint,bigint,bigint,bigint,numeric,timestamptz,numeric,numeric,numeric,text,text,text)') IS NULL
 OR EXISTS(SELECT 1 FROM public.generators WHERE id IN (31001,31002))
 OR EXISTS(SELECT 1 FROM public.inventory_items WHERE tenant_id=10 AND sku='PR359-FUEL-DEADLOCK')
 THEN RAISE EXCEPTION 'PR359_REAL_FUEL_DISPOSABLE_FIXTURE_REQUIRED'; END IF;
END $guard$;
INSERT INTO public.generators(id,tenant_id,site_id,name,fuel_type,operating_hours)
VALUES (31001,10,100,'Fuel deadlock A','diesel',0),(31002,10,100,'Fuel deadlock B','diesel',0);
INSERT INTO public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id)
VALUES(10,'PR359-FUEL-DEADLOCK','Fuel deadlock fixture','fuel','liter',0,1) RETURNING id \gset
SELECT movement_id FROM public.powerhub_inventory_record_stock_movement(10,100,1,1,:id,'adjustment_in',10,8.00,null,'PR359-FUEL-DEADLOCK','Disposable stock','pr359-fuel-deadlock-seed') \gset
INSERT INTO public.inventory_warehouses(tenant_id,site_id,code,name,location_type,generator_id,created_by_user_id)
VALUES(10,100,'PR359-FUEL-DL-A','Fuel tank A','generator_fuel_tank',31001,1) RETURNING id AS tank_a \gset
INSERT INTO public.inventory_warehouses(tenant_id,site_id,code,name,location_type,generator_id,created_by_user_id)
VALUES(10,100,'PR359-FUEL-DL-B','Fuel tank B','generator_fuel_tank',31002,1) RETURNING id AS tank_b \gset
SELECT :id, :tank_a, :tank_b, to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
SQL
IFS='|' read -r item tank_a tank_b occurred < "$tmp/seed"
for value in "$item" "$tank_a" "$tank_b"; do [[ "$value" =~ ^[1-9][0-9]*$ ]] || exit 2; done
[[ "$occurred" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$ ]] || exit 2
a1="SELECT 'A1' FROM public.powerhub_inventory_record_fuel_fill(10,100,1,31001,$item,1,$tank_a,1,'$occurred'::timestamptz,null,null,null,'A1',null,'pr359-fuel-deadlock-a1');"
a2="SELECT 'A2' FROM public.powerhub_inventory_record_fuel_fill(10,100,1,31002,$item,1,$tank_b,1,'$occurred'::timestamptz,null,null,null,'A2',null,'pr359-fuel-deadlock-a2');"
b1="SELECT 'B1' FROM public.powerhub_inventory_record_fuel_fill(10,100,1,31002,$item,1,$tank_b,1,'$occurred'::timestamptz,null,null,null,'B1',null,'pr359-fuel-deadlock-b1');"
coproc WRITER { run_sql 2>"$tmp/a.err"; }
a_pid="$WRITER_PID"; a_in="${WRITER[1]}"; a_out="${WRITER[0]}"
printf '%s\n' "SET application_name='pr359_real_fuel_rpc_a';" "SET statement_timeout='30s';" "SET deadlock_timeout='1s';" 'BEGIN;' "$a1" >&"$a_in"
IFS= read -r -t 20 line <&"$a_out"
[[ "$line" == A1 ]] || exit 1
{
 printf '%s\n' "SET application_name='pr359_real_fuel_rpc_b';" "SET statement_timeout='30s';" "SET deadlock_timeout='1s';" 'BEGIN;' "$b1" 'COMMIT;'
} | run_sql >"$tmp/b.out" 2>"$tmp/b.err" &
b_pid="$!"
blocked=0
for i in $(seq 1 100); do
  n="$(run_sql <<'SQL'
SELECT count(*) FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
WHERE b.datname=current_database() AND a.datname=current_database()
AND b.application_name='pr359_real_fuel_rpc_b' AND a.application_name='pr359_real_fuel_rpc_a' AND b.wait_event_type='Lock';
SQL
)"
  if [[ "$n" == 1 ]]; then blocked=1; break; fi
  sleep 0.1
done
[[ "$blocked" == 1 ]] || { cat "$tmp/b.err" >&2; exit 1; }
printf '%s\n' "$a2" 'COMMIT;' '\q' >&"$a_in"
a_status=0; b_status=0
if wait "$a_pid"; then :; else a_status=$?; fi
a_pid=''
if wait "$b_pid"; then :; else b_status=$?; fi
b_pid=''
if [[ "$a_status" != 0 && "$b_status" == 0 ]] && grep -q '40P01:' "$tmp/a.err"; then
  victim=A; expected_a=0; expected_b=1
elif [[ "$b_status" != 0 && "$a_status" == 0 ]] && grep -q '40P01:' "$tmp/b.err"; then
  victim=B; expected_a=2; expected_b=0
else
  echo "PR359_REAL_RPC_EXPECTED_DEADLOCK_MISSING A=$a_status B=$b_status" >&2
  cat "$tmp/a.err" "$tmp/b.err" >&2
  exit 1
fi
echo "PR359_REAL_FUEL_RPC_LOCK_CYCLE_CHARACTERIZED victim=$victim"
verify() {
  local a="$1" b="$2" marker="$3"
  run_sql <<SQL
DO \$verify\$
BEGIN
 IF (SELECT count(*) FROM public.generator_fuel_events WHERE tenant_id=10 AND site_id=100 AND fuel_item_id=$item AND operation_key IN ('pr359-fuel-deadlock-a1','pr359-fuel-deadlock-a2','pr359-fuel-deadlock-concurrent-replay'))<>$a
 OR (SELECT count(*) FROM public.generator_fuel_events WHERE tenant_id=10 AND site_id=100 AND fuel_item_id=$item AND operation_key='pr359-fuel-deadlock-b1')<>$b
 OR (SELECT count(*) FROM public.inventory_stock_movements WHERE tenant_id=10 AND site_id=100 AND item_id=$item AND movement_type='fuel_consumption')<>($a+$b)
 OR (SELECT count(*) FROM public.audit_logs WHERE tenant_id=10 AND site_id=100 AND entity_type='generator_fuel_event' AND action='create' AND metadata->>'operationKey' IN ('pr359-fuel-deadlock-a1','pr359-fuel-deadlock-a2','pr359-fuel-deadlock-b1','pr359-fuel-deadlock-concurrent-replay'))<>($a+$b)
 OR (SELECT coalesce(sum(CASE WHEN movement_type='adjustment_in' THEN quantity ELSE -quantity END),0) FROM public.inventory_stock_movements WHERE tenant_id=10 AND site_id=100 AND item_id=$item AND warehouse_id=1)<>(10-$a-$b)
 OR (SELECT coalesce(sum(total_cost_amount),0) FROM public.generator_fuel_events WHERE tenant_id=10 AND site_id=100 AND fuel_item_id=$item) IS DISTINCT FROM (8.00*($a+$b))::numeric
 OR (SELECT coalesce(sum(total_cost_amount),0) FROM public.inventory_stock_movements WHERE tenant_id=10 AND site_id=100 AND item_id=$item AND movement_type='fuel_consumption') IS DISTINCT FROM (8.00*($a+$b))::numeric
 OR EXISTS(SELECT 1 FROM public.generator_fuel_readings WHERE tenant_id=10 AND site_id=100 AND generator_id IN (31001,31002))
 OR (SELECT count(*) FROM public.powerhub_sync_changes c WHERE c.tenant_id=10 AND c.site_id=100 AND c.entity_type='fuel_events' AND c.entity_id IN (SELECT id::text FROM public.generator_fuel_events WHERE tenant_id=10 AND site_id=100 AND fuel_item_id=$item))<>($a+$b)
 OR EXISTS(SELECT 1 FROM public.generator_fuel_events p WHERE p.tenant_id=10 AND p.site_id=100 AND p.fuel_item_id=$item
   AND (SELECT count(*) FROM public.powerhub_sync_changes c WHERE c.tenant_id=p.tenant_id AND c.site_id=p.site_id AND c.entity_type='fuel_events' AND c.entity_id=p.id::text AND c.change_type='upsert' AND c.row_data=public.powerhub_project_fuel_event_delta_row(p.tenant_id,p.site_id,p.id))<>1)
 THEN RAISE EXCEPTION 'PR359_REAL_FUEL_RPC_EFFECT_MISMATCH'; END IF;
END \$verify\$;
SELECT '$marker';
SQL
}
verify "$expected_a" "$expected_b" PR359_REAL_FUEL_RPC_DEADLOCK_VICTIM_ATOMIC_PASS
if [[ "$victim" == A ]]; then
  printf '%s\n' 'BEGIN;' "$a1" "$a2" 'COMMIT;' | run_sql >/dev/null
else
  printf '%s\n' 'BEGIN;' "$b1" 'COMMIT;' | run_sql >/dev/null
fi
verify 2 1 PR359_REAL_FUEL_RPC_WHOLE_TRANSACTION_RETRY_PASS
printf '%s\n' 'BEGIN;' "$a1" "$a2" "$b1" 'COMMIT;' | run_sql >/dev/null
verify 2 1 PR359_REAL_FUEL_RPC_DEADLOCK_REPLAY_PASS

# A single RPC per transaction, same exact operation key and payload.
# Observe real lock contention and require the same result identity with
# replayed=true only after the first transaction commits.
sql="SELECT fuel_event_id::text||'|'||replayed::text FROM public.powerhub_inventory_record_fuel_fill(10,100,1,31001,$item,1,$tank_a,1,'$occurred'::timestamptz,null,null,null,'Replay',null,'pr359-fuel-deadlock-concurrent-replay');"
coproc WRITER { run_sql 2>"$tmp/replay-a.err"; }
a_pid="$WRITER_PID"; a_in="${WRITER[1]}"; a_out="${WRITER[0]}"
printf '%s\n' "SET application_name='pr359_fuel_replay_a';" "SET statement_timeout='30s';" "SET lock_timeout='20s';" 'BEGIN;' "$sql" >&"$a_in"
IFS= read -r -t 20 result <&"$a_out"
[[ "$result" =~ ^[1-9][0-9]*\|false$ ]] || { echo "unexpected first response: $result" >&2; exit 1; }
id="${result%%|*}"
{
 printf '%s\n' "SET application_name='pr359_fuel_replay_b';" "SET statement_timeout='30s';" "SET lock_timeout='20s';" 'BEGIN;' "$sql" 'COMMIT;'
} | run_sql >"$tmp/replay-b.out" 2>"$tmp/replay-b.err" &
b_pid="$!"
blocked=0
for i in $(seq 1 100); do
 n="$(run_sql <<'SQL'
SELECT count(*) FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
WHERE b.datname=current_database() AND a.datname=current_database()
AND b.application_name='pr359_fuel_replay_b' AND a.application_name='pr359_fuel_replay_a' AND b.wait_event_type='Lock';
SQL
)"
 if [[ "$n" == 1 ]]; then blocked=1; break; fi
 sleep 0.1
done
[[ "$blocked" == 1 ]] || { cat "$tmp/replay-b.err" >&2; exit 1; }
printf '%s\n' 'COMMIT;' '\q' >&"$a_in"
if ! wait "$a_pid"; then cat "$tmp/replay-a.err" >&2; exit 1; fi
a_pid=''
if ! wait "$b_pid"; then cat "$tmp/replay-b.err" >&2; exit 1; fi
b_pid=''
[[ "$(cat "$tmp/replay-b.out")" == "$id|true" ]] || { cat "$tmp/replay-b.out" >&2; exit 1; }
verify 3 1 PR359_REAL_FUEL_RPC_CONCURRENT_EXACT_REPLAY_PASS
# Replay once more with no concurrency and require unchanged effects.
[[ "$(printf '%s\n' "$sql" | run_sql)" == "$id|true" ]] || exit 1
verify 3 1 PR359_REAL_FUEL_RPC_CONCURRENT_REPLAY_STABLE_EFFECTS_PASS
echo PR359_REAL_FUEL_GLOBAL_LOCK_ORDER_APPROVED=FALSE
