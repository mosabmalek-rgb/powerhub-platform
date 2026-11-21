#!/usr/bin/env bash
# D17 disposable PostgreSQL 17 ONLY: two real financial writers and two
# consistent-snapshot cash readers contend on the same account pair.
# This is not Staging load, GL consolidation, or a production p95/p99 SLA.
set -euo pipefail
[[ "$PGDATABASE" == powerhub_b5_synthetic_load_test &&
   "$PGHOST" == 127.0.0.1 && "$PGPORT" == 5432 &&
   "$PGUSER" == postgres ]] || {
  echo D17_REFUSED_NON_DISPOSABLE_POSTGRES >&2; exit 2;
}
: "$PGPASSWORD"
db() { psql -XAt --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$PGDATABASE" "$@"; }
[[ "$(db -c 'SELECT current_database()')" == powerhub_b5_synthetic_load_test ]] || exit 2

db <<'SQL'
DO $guard$
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_load_test' OR
    (SELECT count(*) FROM public.b5_measurements)<>1000 OR
    (SELECT count(*) FROM public.d14_measurements)<>100
 THEN RAISE EXCEPTION 'D17_REAL_RPC_BASELINE_NOT_READY'; END IF;
END $guard$;
CREATE TABLE public.d17_mixed_events(
  worker integer NOT NULL CHECK (worker BETWEEN 1 AND 4),
  iteration integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reader','writer')),
  backend_pid integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  elapsed_ms numeric(14,3) NOT NULL,
  operation_type text,
  primary_id bigint,
  counterpart_id bigint,
  transfer_net numeric NOT NULL DEFAULT 0,
  transfer_count_net bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(worker,iteration)
);
GRANT INSERT,SELECT ON public.d17_mixed_events TO service_role;

CREATE FUNCTION public.d17_mixed_write(p_worker int,p_iteration int)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public,pg_temp
AS $writer$
DECLARE
  v_started timestamptz;v_finished timestamptz;v_op text;v_key uuid;
  v_first bigint;v_second bigint;v_replayed boolean;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_load_test'
    OR p_worker NOT IN (1,2) OR p_iteration NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'D17_WRITER_SCOPE_INVALID';END IF;
 IF p_iteration=1 THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('D17:mix-start:1:10',0));
 END IF;
 v_op:=CASE WHEN (p_iteration+p_worker)%5=0 THEN 'transfer'
            WHEN (p_iteration+p_worker)%5 IN (1,2) THEN 'withdrawal'
            ELSE 'deposit' END;
 v_key:=md5('D17-mixed:'||p_worker||':'||p_iteration)::uuid;
 v_started:=clock_timestamp();
 IF v_op='transfer' THEN
   SELECT from_transaction_id,to_transaction_id,replayed
     INTO v_first,v_second,v_replayed
   FROM public.powerhub_transfer_company_accounts_idempotent(
     1,10,7,100,200,1.25,'D17 mixed-source '||p_worker||':'||p_iteration,v_key);
 ELSE
   SELECT transaction_id,replayed INTO v_first,v_replayed
   FROM public.powerhub_add_account_movement_idempotent(
     1,10,7,100,v_op,1.25,'D17 mixed-source '||p_worker||':'||p_iteration,
     'D17-'||p_worker||'-'||p_iteration,v_key);
 END IF;
 v_finished:=clock_timestamp();
 IF v_first IS NULL OR v_replayed IS DISTINCT FROM false OR
   (v_op='transfer') IS DISTINCT FROM (v_second IS NOT NULL)
 THEN RAISE EXCEPTION 'D17_WRITER_REPLAY_OR_TRANSFER_INCOMPLETE';END IF;
 INSERT INTO public.d17_mixed_events
 (worker,iteration,kind,backend_pid,started_at,finished_at,elapsed_ms,
  operation_type,primary_id,counterpart_id)
 VALUES(p_worker,p_iteration,'writer',pg_backend_pid(),v_started,v_finished,
  round(extract(epoch FROM v_finished-v_started)::numeric*1000,3),
  v_op,v_first,v_second);
 RETURN 'D17_WRITE_OK';
END $writer$;

CREATE FUNCTION public.d17_mixed_read(p_worker int,p_iteration int)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public,pg_temp
AS $reader$
DECLARE
  v_started timestamptz;v_finished timestamptz;
  v_net numeric;v_count_net bigint;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_load_test'
  OR p_worker NOT IN (3,4) OR p_iteration NOT BETWEEN 1 AND 80
 THEN RAISE EXCEPTION 'D17_READER_SCOPE_INVALID';END IF;
 IF p_iteration=1 THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('D17:mix-start:1:10',0));
 END IF;
 v_started:=clock_timestamp();
 -- One SQL statement => one PostgreSQL MVCC snapshot while writers commit.
 -- Every posted transfer must be an atomic outgoing/incoming pair.
 SELECT coalesce(sum(CASE WHEN transaction_type='transfer_in' THEN amount
                          WHEN transaction_type='transfer_out' THEN -amount
                          ELSE 0 END),0),
        count(*) FILTER(WHERE transaction_type='transfer_in')-
        count(*) FILTER(WHERE transaction_type='transfer_out')
 INTO v_net,v_count_net
 FROM public.account_transactions
 WHERE tenant_id=1 AND site_id=10 AND account_id IN (100,200);
 IF v_net<>0 OR v_count_net<>0
 THEN RAISE EXCEPTION 'D17_READER_OBSERVED_HALF_TRANSFER net=% count_net=%',
   v_net,v_count_net; END IF;
 -- Non-financial delay makes actual reader/writer overlap observable.
 -- The sample latency deliberately includes this delay; not a report SLA.
 PERFORM pg_sleep(0.008);
 v_finished:=clock_timestamp();
 INSERT INTO public.d17_mixed_events
 (worker,iteration,kind,backend_pid,started_at,finished_at,elapsed_ms,
  operation_type,transfer_net,transfer_count_net)
 VALUES(p_worker,p_iteration,'reader',pg_backend_pid(),v_started,v_finished,
  round(extract(epoch FROM v_finished-v_started)::numeric*1000,3),
  'snapshot',v_net,v_count_net);
 RETURN 'D17_READ_OK';
END $reader$;
REVOKE ALL ON FUNCTION public.d17_mixed_write(int,int) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.d17_mixed_read(int,int) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.d17_mixed_write(int,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.d17_mixed_read(int,int) TO service_role;
SQL

tempdir="$(mktemp -d)"
trap 'rm -rf "$tempdir"' EXIT
start_deadlocks="$(db -c "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")"
[[ "$start_deadlocks" =~ ^[0-9]+$ ]] || exit 1
barrier="hashtextextended('D17:mix-start:1:10',0)"
(db -c "SELECT pg_advisory_lock($barrier);SELECT pg_sleep(4);SELECT pg_advisory_unlock($barrier);" >/dev/null) &
coordinator=$!
held=0
for attempt in $(seq 1 50); do
 if [[ "$(db -c "SELECT NOT pg_try_advisory_lock($barrier)")" == t ]];then held=1;break;fi
 sleep 0.05
done
[[ "$held" == 1 ]] || { wait "$coordinator" || true; echo D17_BARRIER_NOT_HELD >&2;exit 1; }

worker_pids=""
for worker in 1 2 3 4;do
 {
  echo 'SET ROLE service_role;'
  if (( worker <= 2 ));then
    for i in $(seq 1 100);do
      printf 'SELECT public.d17_mixed_write(%d,%d);\n' "$worker" "$i"
    done
  else
    for i in $(seq 1 80);do
      printf 'SELECT public.d17_mixed_read(%d,%d);\n' "$worker" "$i"
    done
  fi
  echo 'RESET ROLE;'
 } | db >"$tempdir/worker-$worker.out" 2>"$tempdir/worker-$worker.err" &
 worker_pids="$worker_pids $!"
done

# Prove all FOUR PostgreSQL backends are simultaneously waiting on the real
# coordinated start key; distinct backend PIDs alone do not prove overlap.
simultaneous_waiters=0
for attempt in $(seq 1 65);do
 waiters="$(db -c "SELECT count(DISTINCT pid) FROM pg_stat_activity
 WHERE datname=current_database() AND wait_event_type='Lock'
   AND query LIKE '%public.d17_mixed_%'")"
 [[ "$waiters" =~ ^[0-9]+$ ]] || exit 1
 if (( waiters > simultaneous_waiters ));then simultaneous_waiters="$waiters";fi
 if (( simultaneous_waiters >= 4 ));then break;fi
 sleep 0.05
done
failed=0
for pid in $worker_pids;do wait "$pid" || failed=1;done
wait "$coordinator" || failed=1
if [[ "$failed" != 0 || "$simultaneous_waiters" -lt 4 ]];then
  echo "D17_SIMULTANEOUS_BACKENDS_NOT_PROVEN waiters=$simultaneous_waiters errors=$failed" >&2
  for worker in 1 2 3 4;do cat "$tempdir/worker-$worker.err" >&2;done
  exit 1
fi
for worker in 1 2;do
 [[ "$(grep -c '^D17_WRITE_OK$' "$tempdir/worker-$worker.out" || true)" == 100 ]] ||
 { echo "D17_WRITER_INCOMPLETE_$worker" >&2;exit 1; }
done
for worker in 3 4;do
 [[ "$(grep -c '^D17_READ_OK$' "$tempdir/worker-$worker.out" || true)" == 80 ]] ||
 { echo "D17_READER_INCOMPLETE_$worker" >&2;exit 1; }
done
end_deadlocks="$(db -c "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")"
[[ "$end_deadlocks" == "$start_deadlocks" ]] ||
 { echo "D17_DEADLOCKS_RAISED $start_deadlocks/$end_deadlocks" >&2; exit 1; }

db <<'SQL'
DO $assert$
DECLARE
 n int; sessions int; writes int; reads int; transfers int;
 side_effects int; audited int; cash numeric; wallet numeric;
 deposits numeric; withdrawals numeric; overlapped boolean;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_load_test'
 THEN RAISE EXCEPTION 'D17_NOT_DISPOSABLE_DB';END IF;
 SELECT count(*),count(DISTINCT backend_pid),
   count(*) FILTER(WHERE kind='writer'),
   count(*) FILTER(WHERE kind='reader')
 INTO n,sessions,writes,reads FROM public.d17_mixed_events;
 IF n<>360 OR sessions<>4 OR writes<>200 OR reads<>160
 THEN RAISE EXCEPTION 'D17_BAD_WORKER_COUNTS n=% pid=% write=% read=%',
 n,sessions,writes,reads;END IF;
 SELECT EXISTS(
   SELECT 1 FROM public.d17_mixed_events r
   JOIN public.d17_mixed_events w
    ON r.kind='reader' AND w.kind='writer' AND r.backend_pid<>w.backend_pid
   WHERE r.started_at < w.finished_at AND w.started_at < r.finished_at
 ) INTO overlapped;
 IF NOT overlapped THEN RAISE EXCEPTION 'D17_READER_WRITER_INTERVALS_DID_NOT_OVERLAP';END IF;
 IF EXISTS(SELECT 1 FROM public.d17_mixed_events
  WHERE elapsed_ms<0 OR finished_at<started_at OR
    (kind='reader' AND (transfer_net<>0 OR transfer_count_net<>0)) OR
    (kind='writer' AND primary_id IS NULL))
 THEN RAISE EXCEPTION 'D17_INCONSISTENT_SNAPSHOT_OR_MEASUREMENT';END IF;
 IF (SELECT count(DISTINCT primary_id) FROM public.d17_mixed_events WHERE kind='writer')<>200
 THEN RAISE EXCEPTION 'D17_REPEATED_WRITER_TRANSACTION';END IF;
 SELECT count(*) INTO transfers FROM public.d17_mixed_events
 WHERE kind='writer' AND operation_type='transfer';
 IF transfers<>40 THEN RAISE EXCEPTION 'D17_WRONG_TRANSFER_DISTRIBUTION';END IF;
 SELECT count(*) INTO n FROM public.company_account_movement_operations
 WHERE tenant_id=1 AND operation_key IN(
   SELECT md5('D17-mixed:'||worker||':'||iteration)::uuid
   FROM public.d17_mixed_events WHERE kind='writer');
 IF n<>200 THEN RAISE EXCEPTION 'D17_NOT_EXACTLY_200_FINANCIAL_OPERATIONS';END IF;
 SELECT count(*) INTO side_effects FROM public.account_transactions
 WHERE tenant_id=1 AND id IN (
  SELECT primary_id FROM public.d17_mixed_events WHERE kind='writer'
  UNION SELECT counterpart_id FROM public.d17_mixed_events
  WHERE kind='writer' AND counterpart_id IS NOT NULL);
 IF side_effects<>240 THEN RAISE EXCEPTION 'D17_NOT_EXACTLY_240_ACCOUNT_MOVEMENTS';END IF;
 SELECT count(*) INTO audited FROM public.audit_logs
 WHERE tenant_id=1 AND metadata->>'operationKey' IN(
   SELECT (md5('D17-mixed:'||worker||':'||iteration)::uuid)::text
   FROM public.d17_mixed_events WHERE kind='writer');
 IF audited<>200 THEN RAISE EXCEPTION 'D17_NOT_EXACTLY_200_AUDIT_EVENTS';END IF;
 IF EXISTS(
 SELECT 1 FROM public.d17_mixed_events e
 JOIN public.company_account_movement_operations o
   ON o.tenant_id=1 AND o.operation_key=md5('D17-mixed:'||e.worker||':'||e.iteration)::uuid
 JOIN public.account_transactions a ON a.id=o.primary_transaction_id
 LEFT JOIN public.account_transactions b ON b.id=o.counterpart_transaction_id
 WHERE e.kind='writer' AND
   (o.site_id<>10 OR o.operation_type<>e.operation_type OR
     a.tenant_id<>1 OR a.site_id<>10 OR a.amount<>1.25 OR
     a.id<>e.primary_id OR b.id IS DISTINCT FROM e.counterpart_id OR
     (o.operation_type='transfer' AND (b.id IS NULL OR
      b.tenant_id<>1 OR b.site_id<>10 OR b.amount<>a.amount OR
      a.transaction_type<>'transfer_out' OR b.transaction_type<>'transfer_in')))
 ) THEN RAISE EXCEPTION 'D17_UNPAIRED_OR_UNSCOPED_FINANCIAL_SOURCE';END IF;
 SELECT a.opening_balance+coalesce(sum(
   CASE WHEN t.transaction_type IN('deposit','transfer_in','collection')
      THEN t.amount ELSE -t.amount END),0) INTO cash
 FROM public.company_accounts a
 LEFT JOIN public.account_transactions t
 ON t.tenant_id=a.tenant_id AND t.account_id=a.id
 WHERE a.tenant_id=1 AND a.id=100 GROUP BY a.opening_balance;
 SELECT a.opening_balance+coalesce(sum(
   CASE WHEN t.transaction_type IN('deposit','transfer_in','collection')
      THEN t.amount ELSE -t.amount END),0) INTO wallet
 FROM public.company_accounts a
 LEFT JOIN public.account_transactions t
 ON t.tenant_id=a.tenant_id AND t.account_id=a.id
 WHERE a.tenant_id=1 AND a.id=200 GROUP BY a.opening_balance;
 SELECT coalesce(sum(amount) FILTER(WHERE transaction_type='deposit'),0),
 coalesce(sum(amount) FILTER(WHERE transaction_type='withdrawal'),0)
 INTO deposits,withdrawals FROM public.account_transactions WHERE tenant_id=1;
 IF cash+wallet<>1300000+deposits-withdrawals
 THEN RAISE EXCEPTION 'D17_ACCOUNT_BALANCE_CONSERVATION_FAILURE';END IF;
 IF has_function_privilege('anon',
   'public.d17_mixed_write(integer,integer)','EXECUTE') OR
   has_function_privilege('authenticated',
   'public.d17_mixed_read(integer,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'D17_TEST_HELPER_PUBLIC_EXECUTE';END IF;
END $assert$;

SELECT kind,count(*) sample_count,
 round(percentile_cont(.50) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p50_ms,
 round(percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p95_ms,
 round(percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p99_ms,
 round(max(elapsed_ms),2) maximum_ms,
 count(DISTINCT backend_pid) distinct_backends
FROM public.d17_mixed_events GROUP BY kind ORDER BY kind;
SELECT 'D17_MIXED_READ_WRITE_4_SIMULTANEOUS_POSTGRES_BACKENDS_PASS' AS result;
SQL
echo "D17_SIMULTANEOUS_ADVISORY_WAITERS=$simultaneous_waiters D17_DEADLOCK_DELTA=0"
