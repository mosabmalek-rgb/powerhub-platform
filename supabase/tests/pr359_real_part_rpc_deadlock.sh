#!/usr/bin/env bash
# Disposable CI fixture only. Actual maintenance RPCs, no injected SQLSTATE.
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
 OR NOT EXISTS(SELECT 1 FROM public.generators WHERE tenant_id=10 AND site_id=100 AND id=10000)
 OR to_regprocedure('public.powerhub_maintenance_add_part(bigint,bigint,bigint,bigint,bigint,bigint,numeric,text,text)') IS NULL
 OR EXISTS(SELECT 1 FROM public.inventory_items WHERE tenant_id=10 AND sku='PR359-REAL-DEADLOCK')
 THEN RAISE EXCEPTION 'PR359_REAL_RPC_DISPOSABLE_FIXTURE_REQUIRED'; END IF;
END $guard$;
INSERT INTO public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id)
VALUES(10,'PR359-REAL-DEADLOCK','Deadlock fixture','spare_part','piece',0,1) RETURNING id \gset
SELECT movement_id FROM public.powerhub_inventory_record_stock_movement(10,100,1,1,:id,'adjustment_in',10,12.50,null,'PR359-DEADLOCK','Disposable stock','pr359-real-deadlock-seed') \gset
SELECT work_order_id AS a_order FROM public.powerhub_maintenance_create_work_order(10,100,1,10000,null,'breakdown','high','Deadlock A',null,now(),null,null,'pr359-real-deadlock-order-a') \gset
SELECT work_order_id AS b_order FROM public.powerhub_maintenance_create_work_order(10,100,1,10000,null,'breakdown','high','Deadlock B',null,now(),null,null,'pr359-real-deadlock-order-b') \gset
SELECT :id, :a_order, :b_order;
SQL
IFS='|' read -r item order_a order_b < "$tmp/seed"
for value in "$item" "$order_a" "$order_b"; do [[ "$value" =~ ^[1-9][0-9]*$ ]] || exit 2; done
a1="SELECT 'A1' FROM public.powerhub_maintenance_add_part(10,100,1,$order_a,$item,1,1,'A1','pr359-real-deadlock-a1');"
a2="SELECT 'A2' FROM public.powerhub_maintenance_add_part(10,100,1,$order_b,$item,1,1,'A2','pr359-real-deadlock-a2');"
b1="SELECT 'B1' FROM public.powerhub_maintenance_add_part(10,100,1,$order_b,$item,1,1,'B1','pr359-real-deadlock-b1');"
coproc WRITER { run_sql 2>"$tmp/a.err"; }
a_pid="$WRITER_PID"; a_in="${WRITER[1]}"; a_out="${WRITER[0]}"
printf '%s\n' "SET application_name='pr359_real_rpc_a';" "SET statement_timeout='30s';" "SET deadlock_timeout='1s';" 'BEGIN;' "$a1" >&"$a_in"
IFS= read -r -t 20 line <&"$a_out"
[[ "$line" == A1 ]] || exit 1
{
 printf '%s\n' "SET application_name='pr359_real_rpc_b';" "SET statement_timeout='30s';" "SET deadlock_timeout='1s';" 'BEGIN;' "$b1" 'COMMIT;'
} | run_sql >"$tmp/b.out" 2>"$tmp/b.err" &
b_pid="$!"
blocked=0
for i in $(seq 1 100); do
  n="$(run_sql <<'SQL'
SELECT count(*) FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
WHERE b.datname=current_database() AND a.datname=current_database()
AND b.application_name='pr359_real_rpc_b' AND a.application_name='pr359_real_rpc_a' AND b.wait_event_type='Lock';
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
echo "PR359_REAL_PART_RPC_LOCK_CYCLE_CHARACTERIZED victim=$victim"
verify() {
  local a="$1" b="$2" marker="$3"
  run_sql <<SQL
DO \$verify\$
BEGIN
 IF (SELECT count(*) FROM public.generator_maintenance_work_order_parts WHERE tenant_id=10 AND site_id=100 AND item_id=$item AND operation_key IN ('pr359-real-deadlock-a1','pr359-real-deadlock-a2'))<>$a
 OR (SELECT count(*) FROM public.generator_maintenance_work_order_parts WHERE tenant_id=10 AND site_id=100 AND item_id=$item AND operation_key='pr359-real-deadlock-b1')<>$b
 OR (SELECT count(*) FROM public.inventory_stock_movements WHERE tenant_id=10 AND site_id=100 AND item_id=$item AND movement_type='issue')<>($a+$b)
 OR (SELECT count(*) FROM public.generator_maintenance_audit_events WHERE tenant_id=10 AND site_id=100 AND action='issue' AND operation_key IN ('pr359-real-deadlock-a1','pr359-real-deadlock-a2','pr359-real-deadlock-b1'))<>($a+$b)
 OR (SELECT coalesce(sum(CASE WHEN movement_type='adjustment_in' THEN quantity ELSE -quantity END),0) FROM public.inventory_stock_movements WHERE tenant_id=10 AND site_id=100 AND item_id=$item AND warehouse_id=1)<>(10-$a-$b)
 OR (SELECT sum(parts_cost) FROM public.generator_maintenance_work_orders WHERE id IN ($order_a,$order_b) AND tenant_id=10 AND site_id=100) IS DISTINCT FROM (12.50*($a+$b))::numeric
 OR (SELECT count(*) FROM public.powerhub_sync_changes WHERE tenant_id=10 AND site_id=100 AND entity_type IN ('maintenance_work_order_parts:'||$order_a::text,'maintenance_work_order_parts:'||$order_b::text))<>($a+$b)
 OR EXISTS(SELECT 1 FROM public.generator_maintenance_work_order_parts p WHERE p.tenant_id=10 AND p.site_id=100 AND p.item_id=$item
   AND (SELECT count(*) FROM public.powerhub_sync_changes c WHERE c.tenant_id=p.tenant_id AND c.site_id=p.site_id AND c.entity_type='maintenance_work_order_parts:'||p.work_order_id::text AND c.entity_id=p.id::text AND c.change_type='upsert' AND c.row_data=public.powerhub_project_maintenance_work_order_part_delta_row(p.tenant_id,p.site_id,p.work_order_id,p.id))<>1)
 THEN RAISE EXCEPTION 'PR359_REAL_PART_RPC_EFFECT_MISMATCH'; END IF;
END \$verify\$;
SELECT '$marker';
SQL
}
verify "$expected_a" "$expected_b" PR359_REAL_PART_RPC_DEADLOCK_VICTIM_ATOMIC_PASS
if [[ "$victim" == A ]]; then
  printf '%s\n' 'BEGIN;' "$a1" "$a2" 'COMMIT;' | run_sql >/dev/null
else
  printf '%s\n' 'BEGIN;' "$b1" 'COMMIT;' | run_sql >/dev/null
fi
verify 2 1 PR359_REAL_PART_RPC_WHOLE_TRANSACTION_RETRY_PASS
printf '%s\n' 'BEGIN;' "$a1" "$a2" "$b1" 'COMMIT;' | run_sql >/dev/null
verify 2 1 PR359_REAL_PART_RPC_DEADLOCK_REPLAY_PASS
echo PR359_REAL_RPC_GLOBAL_LOCK_ORDER_APPROVED=FALSE
