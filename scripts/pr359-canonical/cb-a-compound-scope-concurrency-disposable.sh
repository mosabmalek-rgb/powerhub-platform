#!/usr/bin/env bash
# Exercise real part UPDATE triggers with opposite and ordered scope locks.
# Called only after the isolated Emit candidate is installed.
set -euo pipefail
: "${PR359_TEST_CONTAINER:?Missing disposable container}"
: "${PR359_TEST_PASSWORD:?Missing test password}"
[[ "$PR359_TEST_CONTAINER" =~ ^pr359-definer-[0-9a-f]{12}$ ]] || exit 2
[[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$PR359_TEST_CONTAINER")" == none ]] || exit 2
[[ -z "$(docker port "$PR359_TEST_CONTAINER")" ]] || exit 2
[[ "$#" == 0 ]] || exit 2
db=pr359_indirect_concurrency
tmp="$(mktemp -d)"
writer_pid=''; writer_in=''; second_pid=''
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
 rm -rf "$tmp"
}
trap cleanup EXIT
run_sql(){
 docker exec -i -e "PGPASSWORD=$PR359_TEST_PASSWORD" "$PR359_TEST_CONTAINER" \
 psql -X -w -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -U postgres -d "$db"
}
run_sql <<'SQL' > "$tmp/setup.txt"
DO $guard$
BEGIN
 IF current_database()<>'pr359_indirect_concurrency'
 OR position('PR359_CANDIDATE_EMIT_SCOPE_LOCK_MISSING' in pg_get_functiondef('public.powerhub_emit_fuel_maintenance_delta_sync_change(bigint,bigint,text,bigint)'::regprocedure))=0
 THEN RAISE EXCEPTION 'PR359_COMPOUND_DISPOSABLE_CANDIDATE_REQUIRED'; END IF;
END $guard$;
INSERT INTO public.generator_maintenance_work_order_parts(id,tenant_id,site_id,work_order_id,generator_id,item_id,warehouse_id,quantity)
 VALUES(99005,1,101,98001,1001,74,82,1);
CREATE TABLE public.pr359_compound_before AS SELECT * FROM public.powerhub_sync_scope_state;
CREATE TABLE public.pr359_compound_parts_before AS
 SELECT id,quantity FROM public.generator_maintenance_work_order_parts WHERE id IN (99001,99002,99003,99005);
DO $fixture$
BEGIN
 IF (SELECT count(*) FROM public.pr359_compound_parts_before)<>4
 OR EXISTS(SELECT 1 FROM public.pr359_compound_parts_before WHERE quantity IS DISTINCT FROM 1::numeric)
 THEN RAISE EXCEPTION 'PR359_COMPOUND_FIXTURE_DRIFT'; END IF;
END $fixture$;
SQL
a1="UPDATE public.generator_maintenance_work_order_parts SET quantity=quantity+10 WHERE id=99001 AND tenant_id=1 AND site_id=101;"
a2="UPDATE public.generator_maintenance_work_order_parts SET quantity=quantity+10 WHERE id=99003 AND tenant_id=1 AND site_id=101;"
b1="UPDATE public.generator_maintenance_work_order_parts SET quantity=quantity+20 WHERE id=99002 AND tenant_id=1 AND site_id=101;"
b2="UPDATE public.generator_maintenance_work_order_parts SET quantity=quantity+20 WHERE id=99005 AND tenant_id=1 AND site_id=101;"
coproc COMPOUND_WRITER { run_sql 2>"$tmp/a.err"; }
writer_pid="$COMPOUND_WRITER_PID"
writer_in="${COMPOUND_WRITER[1]}"
writer_out="${COMPOUND_WRITER[0]}"
printf '%s\n' "SET application_name='pr359_compound_a';" "SET statement_timeout='30s';" "SET deadlock_timeout='1s';" 'BEGIN;' "$a1" "SELECT 'A_READY';" >&"$writer_in"
IFS= read -r -t 20 output <&"$writer_out"
[[ "$output" == A_READY ]]
# B holds the second scope, then waits for observable A->B lock contention.
# No shared source row is updated by both transactions.
{
 printf '%s\n' "SET application_name='pr359_compound_b';" "SET statement_timeout='30s';" "SET deadlock_timeout='1s';" 'BEGIN;' "$b1" "SELECT 'B_READY';"
 cat <<'SQL'
DO $wait$
DECLARE deadline timestamptz:=clock_timestamp()+interval '15 seconds'; found_wait boolean:=false;
BEGIN
 LOOP
  PERFORM pg_stat_clear_snapshot();
  SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
    WHERE a.datname=current_database() AND a.application_name='pr359_compound_a'
    AND pg_backend_pid()=ANY(pg_blocking_pids(a.pid))) INTO found_wait;
  EXIT WHEN found_wait;
  IF clock_timestamp()>deadline THEN RAISE EXCEPTION 'PR359_COMPOUND_A_WAIT_NOT_OBSERVED'; END IF;
  PERFORM pg_sleep(0.05);
 END LOOP;
END $wait$;
SQL
 printf '%s\n' "$b2" 'COMMIT;'
} | run_sql > "$tmp/b.txt" 2> "$tmp/b.err" &
second_pid="$!"
ready=0
for i in $(seq 1 100); do
 if grep -Fxq B_READY "$tmp/b.txt"; then ready=1; break; fi
 sleep 0.1
done
[[ "$ready" == 1 ]] || { cat "$tmp/b.err" >&2; exit 1; }
printf '%s\n' "$a2" 'COMMIT;' '\q' >&"$writer_in"
a_status=0; b_status=0
if wait "$writer_pid"; then :; else a_status=$?; fi
writer_pid=''
if wait "$second_pid"; then :; else b_status=$?; fi
second_pid=''
if [[ "$a_status" != 0 && "$b_status" == 0 ]] && grep -q '40P01:' "$tmp/a.err"; then
 victim=A
elif [[ "$b_status" != 0 && "$a_status" == 0 ]] && grep -q '40P01:' "$tmp/b.err"; then
 victim=B
else
 echo "PR359_COMPOUND_EXPECTED_DEADLOCK_MISSING A=$a_status B=$b_status" >&2
 cat "$tmp/a.err" "$tmp/b.err" >&2
 exit 1
fi
echo "PR359_COMPOUND_OPPOSITE_SCOPE_DEADLOCK_CHARACTERIZED victim=$victim"
# Exactly one complete transaction survives; verify quantities and journal.
if [[ "$victim" == A ]]; then
 expected_a=1; expected_b=21
else
 expected_a=11; expected_b=1
fi
run_sql <<SQL > "$tmp/victim.txt"
DO \$check\$
BEGIN
 IF EXISTS(SELECT 1 FROM public.generator_maintenance_work_order_parts p WHERE id IN (99001,99003) AND quantity IS DISTINCT FROM $expected_a::numeric)
 OR EXISTS(SELECT 1 FROM public.generator_maintenance_work_order_parts p WHERE id IN (99002,99005) AND quantity IS DISTINCT FROM $expected_b::numeric)
 OR (SELECT count(*) FROM public.powerhub_sync_changes c JOIN public.pr359_compound_before b USING(tenant_id,site_id,entity_type) WHERE c.cursor>b.last_cursor)<>2
 OR EXISTS(SELECT 1 FROM public.powerhub_sync_scope_state s JOIN public.pr359_compound_before b USING(tenant_id,site_id,entity_type)
 WHERE s.last_cursor-b.last_cursor IS DISTINCT FROM CASE WHEN s.tenant_id=1 AND s.site_id=101 AND s.entity_type IN ('maintenance_work_order_parts:98001','maintenance_work_order_parts:98002') THEN 1 ELSE 0 END::bigint)
 THEN RAISE EXCEPTION 'PR359_COMPOUND_VICTIM_ATOMICITY_FAILED'; END IF;
END \$check\$;
SELECT 'PR359_COMPOUND_DEADLOCK_VICTIM_ATOMIC_PASS';
SQL
grep -Fxq PR359_COMPOUND_DEADLOCK_VICTIM_ATOMIC_PASS "$tmp/victim.txt"
echo PR359_COMPOUND_DEADLOCK_VICTIM_ATOMIC_PASS
# Retry the complete aborted transaction, not only its failed statement.
if [[ "$victim" == A ]]; then
 printf '%s\n' 'BEGIN;' "$a1" "$a2" 'COMMIT;' | run_sql >/dev/null
else
 printf '%s\n' 'BEGIN;' "$b1" "$b2" 'COMMIT;' | run_sql >/dev/null
fi
verify(){
 local a="$1" b="$2" delta="$3"
 run_sql <<SQL
DO \$check\$
BEGIN
 IF EXISTS(SELECT 1 FROM public.generator_maintenance_work_order_parts WHERE id IN (99001,99003) AND quantity IS DISTINCT FROM $a::numeric)
 OR EXISTS(SELECT 1 FROM public.generator_maintenance_work_order_parts WHERE id IN (99002,99005) AND quantity IS DISTINCT FROM $b::numeric)
 OR (SELECT count(*) FROM public.powerhub_sync_changes c JOIN public.pr359_compound_before p USING(tenant_id,site_id,entity_type) WHERE c.cursor>p.last_cursor)<>4
 OR EXISTS(SELECT 1 FROM public.powerhub_sync_scope_state s JOIN public.pr359_compound_before p USING(tenant_id,site_id,entity_type)
 WHERE s.last_cursor-p.last_cursor IS DISTINCT FROM CASE WHEN s.tenant_id=1 AND s.site_id=101 AND s.entity_type IN ('maintenance_work_order_parts:98001','maintenance_work_order_parts:98002') THEN 2 ELSE 0 END::bigint)
 OR EXISTS(SELECT 1 FROM public.generator_maintenance_work_order_parts p WHERE id IN (99001,99002,99003,99005)
 AND (SELECT count(*) FROM public.powerhub_sync_changes c JOIN public.pr359_compound_before b USING(tenant_id,site_id,entity_type)
 WHERE c.tenant_id=p.tenant_id AND c.site_id=p.site_id AND c.entity_type='maintenance_work_order_parts:'||p.work_order_id::text
 AND c.entity_id=p.id::text AND c.cursor>b.last_cursor AND c.change_type='upsert'
 AND c.row_data=public.powerhub_project_maintenance_work_order_part_delta_row(p.tenant_id,p.site_id,p.work_order_id,p.id))<>1)
 THEN RAISE EXCEPTION 'PR359_COMPOUND_JOURNAL_MISMATCH'; END IF;
END \$check\$;
SELECT '$delta';
SQL
}
verify 11 21 PR359_COMPOUND_FULL_TRANSACTION_RETRY_PASS > "$tmp/retry.txt"
grep -Fxq PR359_COMPOUND_FULL_TRANSACTION_RETRY_PASS "$tmp/retry.txt"
echo PR359_COMPOUND_FULL_TRANSACTION_RETRY_PASS
# Characterize a transaction-entry prelock protocol with the same opposing
# business update order. This is a test protocol, not an application rollout.
run_sql <<'SQL' >/dev/null
TRUNCATE public.pr359_compound_before;
INSERT INTO public.pr359_compound_before SELECT * FROM public.powerhub_sync_scope_state;
SQL
prelock="SELECT entity_type FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type IN ('maintenance_work_order_parts:98001','maintenance_work_order_parts:98002') ORDER BY tenant_id,site_id,entity_type COLLATE \"C\" FOR UPDATE;"
coproc COMPOUND_WRITER { run_sql 2>"$tmp/ordered-a.err"; }
writer_pid="$COMPOUND_WRITER_PID"
writer_in="${COMPOUND_WRITER[1]}"
writer_out="${COMPOUND_WRITER[0]}"
printf '%s\n' "SET application_name='pr359_ordered_a';" "SET statement_timeout='30s';" 'BEGIN;' "$prelock" "$a1" "SELECT 'ORDERED_A_READY';" >&"$writer_in"
for expected in maintenance_work_order_parts:98001 maintenance_work_order_parts:98002 ORDERED_A_READY; do
 IFS= read -r -t 20 output <&"$writer_out"
 [[ "$output" == "$expected" ]]
done
{
 printf '%s\n' "SET application_name='pr359_ordered_b';" "SET statement_timeout='30s';" 'BEGIN;' "$prelock" "$b1" "$b2" 'COMMIT;'
} | run_sql > "$tmp/ordered-b.txt" 2> "$tmp/ordered-b.err" &
second_pid="$!"
blocked=0
for i in $(seq 1 60); do
 n="$(run_sql <<'SQL'
SELECT count(*) FROM pg_stat_activity b JOIN pg_stat_activity a ON a.pid=ANY(pg_blocking_pids(b.pid))
WHERE b.datname=current_database() AND a.datname=current_database()
AND b.application_name='pr359_ordered_b' AND a.application_name='pr359_ordered_a'
AND b.wait_event_type='Lock';
SQL
)"
 if [[ "$n" == 1 ]]; then blocked=1; break; fi
 sleep 0.2
done
[[ "$blocked" == 1 ]] || { cat "$tmp/ordered-b.err" >&2; exit 1; }
printf '%s\n' "$a2" 'COMMIT;' '\q' >&"$writer_in"
wait "$writer_pid"
writer_pid=''
wait "$second_pid" || { cat "$tmp/ordered-b.err" >&2; exit 1; }
second_pid=''
verify 21 41 PR359_COMPOUND_ORDERED_PRELOCK_EXACT_JOURNAL_PASS > "$tmp/ordered.txt"
grep -Fxq PR359_COMPOUND_ORDERED_PRELOCK_EXACT_JOURNAL_PASS "$tmp/ordered.txt"
echo PR359_COMPOUND_ORDERED_PRELOCK_EXACT_JOURNAL_PASS
echo PR359_COMPOUND_FULL_CALLER_LOCK_ORDER_APPROVED=FALSE
echo PR359_CANONICAL_BASELINE_APPROVED=FALSE
