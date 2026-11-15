#!/usr/bin/env bash
# D14: disposable PostgreSQL17 only; four independent backends race shared
# idempotency keys through the REAL company-account movement RPCs.
set -euo pipefail
[[ "$PGDATABASE" == powerhub_b5_synthetic_load_test && "$PGHOST" == 127.0.0.1 &&
   "$PGPORT" == 5432 && "$PGUSER" == postgres ]] ||
  { echo D14_LOCAL_DISPOSABLE_ONLY >&2; exit 2; }
: "$PGPASSWORD"
db(){ psql -XAt --no-psqlrc -v ON_ERROR_STOP=1 --dbname "$PGDATABASE" "$@"; }
[[ "$(db -c 'select current_database()')" == powerhub_b5_synthetic_load_test ]] || exit 2

db <<'SQL'
DO $guard$ BEGIN
 IF current_database()<>'powerhub_b5_synthetic_load_test'
 OR (SELECT count(*) FROM public.b5_measurements)<>1000
 THEN RAISE EXCEPTION 'D14_B5_BASELINE_MISSING'; END IF;
END $guard$;
CREATE TABLE public.d14_measurements(
 worker int NOT NULL CHECK(worker BETWEEN 1 AND 4),
 iteration int NOT NULL CHECK(iteration BETWEEN 1 AND 25),
 backend_pid int NOT NULL,
 kind text NOT NULL CHECK(kind IN ('deposit','withdrawal','transfer')),
 primary_id bigint NOT NULL, counterpart_id bigint,
 replayed boolean NOT NULL,
 elapsed_ms numeric(14,3) NOT NULL CHECK(elapsed_ms>=0),
 PRIMARY KEY(worker,iteration)
);
GRANT INSERT,SELECT ON public.d14_measurements TO service_role;

CREATE FUNCTION public.d14_submit(p_worker int,p_iteration int)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $fn$
DECLARE
 v_key uuid; v_type text; v_a bigint; v_b bigint; v_replay boolean;
 v_start timestamptz;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_load_test'
 OR p_worker NOT BETWEEN 1 AND 4 OR p_iteration NOT BETWEEN 1 AND 25
 THEN RAISE EXCEPTION 'D14_INVALID_SCOPE'; END IF;
 v_key:=md5('D14-shared-key:'||p_iteration)::uuid;
 v_type:=CASE WHEN p_iteration%5=0 THEN 'transfer'
              WHEN p_iteration%5=1 THEN 'withdrawal' ELSE 'deposit' END;
 v_start:=clock_timestamp();
 IF v_type='transfer' THEN
  SELECT from_transaction_id,to_transaction_id,replayed INTO v_a,v_b,v_replay
  FROM public.powerhub_transfer_company_accounts_idempotent(
    1,10,7,100,200,1.25,'D14 source '||p_iteration,v_key);
 ELSE
  SELECT transaction_id,replayed INTO v_a,v_replay
  FROM public.powerhub_add_account_movement_idempotent(
    1,10,7,100,v_type,1.25,'D14 source '||p_iteration,
    'D14-REF-'||p_iteration,v_key);
 END IF;
 IF v_a IS NULL OR (v_type='transfer') IS DISTINCT FROM (v_b IS NOT NULL)
 THEN RAISE EXCEPTION 'D14_INCOMPLETE_PAIRED_WRITE'; END IF;
 INSERT INTO public.d14_measurements
 VALUES(p_worker,p_iteration,pg_backend_pid(),v_type,v_a,v_b,v_replay,
   round(extract(epoch FROM clock_timestamp()-v_start)::numeric*1000,3));
 RETURN 'D14_OK';
END $fn$;
REVOKE ALL ON FUNCTION public.d14_submit(int,int) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.d14_submit(int,int) TO service_role;
SQL

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
deadlocks_before="$(db -c "select deadlocks from pg_stat_database where datname=current_database()")"
[[ "$deadlocks_before" =~ ^[0-9]+$ ]] || exit 1
key="hashtextextended('1:company-account-movement:'||(md5('D14-shared-key:1')::uuid)::text,0)"
(db -c "select pg_advisory_lock($key);select pg_sleep(4);select pg_advisory_unlock($key);" >/dev/null) &
coordinator=$!
held=0
for tick in $(seq 1 40); do
 if [[ "$(db -c "select not pg_try_advisory_lock($key)")" == t ]]; then held=1;break;fi
 sleep .05
done
[[ "$held" == 1 ]] || { wait "$coordinator" || true; echo D14_BARRIER_FAILED; exit 1; }

pids=""
for worker in 1 2 3 4; do
 {
   echo 'SET ROLE service_role;'
   for iteration in $(seq 1 25);do
     printf 'select public.d14_submit(%d,%d);\n' "$worker" "$iteration"
   done
   echo 'RESET ROLE;'
 } | db >"$tmp/worker-$worker.out" 2>"$tmp/worker-$worker.err" &
 pids="$pids $!"
done
observed=0
for tick in $(seq 1 40);do
 waiters="$(db -c "select count(distinct pid) from pg_stat_activity
 where datname=current_database() and wait_event_type='Lock'
 and query like '%d14_submit%'")"
 [[ "$waiters" =~ ^[0-9]+$ ]] || exit 1
 if (( waiters > observed ));then observed="$waiters";fi
 if (( observed>=2 ));then break;fi
 sleep .05
done
failed=0
for pid in $pids;do wait "$pid" || failed=1;done
wait "$coordinator" || failed=1
if [[ "$failed" != 0 || "$observed" -lt 2 ]];then
 echo "D14_CONCURRENT_LOCK_WAIT_NOT_PROVEN observed=$observed failed=$failed" >&2
 for worker in 1 2 3 4;do cat "$tmp/worker-$worker.err" >&2;done
 exit 1
fi
for worker in 1 2 3 4;do
 [[ "$(grep -c '^D14_OK$' "$tmp/worker-$worker.out" || true)" == 25 ]] ||
  { echo "D14_WORKER_$worker_INCOMPLETE" >&2;exit 1; }
done
deadlocks_after="$(db -c "select deadlocks from pg_stat_database where datname=current_database()")"
[[ "$deadlocks_after" == "$deadlocks_before" ]] ||
 { echo "D14_DEADLOCK_COUNT_INCREASED $deadlocks_before->$deadlocks_after" >&2;exit 1; }

db <<'SQL'
DO $proof$
DECLARE n int; sessions int; originals int; replays int; transfers int;
        side_effects int; audits int; rejected boolean; cash numeric;wallet numeric;
        deposits numeric;withdrawals numeric;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_load_test'
 THEN RAISE EXCEPTION 'D14_NOT_DISPOSABLE';END IF;
 SELECT count(*),count(distinct backend_pid),
 count(*) FILTER(WHERE NOT replayed),count(*) FILTER(WHERE replayed)
 INTO n,sessions,originals,replays FROM public.d14_measurements;
 IF n<>100 OR sessions<>4 OR originals<>25 OR replays<>75
 THEN RAISE EXCEPTION 'D14_COUNTS_BAD requests=% sessions=% originals=% replay=%',
 n,sessions,originals,replays;END IF;
 IF EXISTS(SELECT 1 FROM public.d14_measurements GROUP BY iteration
 HAVING count(*)<>4 OR count(distinct primary_id)<>1 OR
 count(distinct coalesce(counterpart_id,0))<>1 OR
 count(*) FILTER(WHERE replayed)<>3 OR count(*) FILTER(WHERE NOT replayed)<>1)
 THEN RAISE EXCEPTION 'D14_MULTIPLE_SIDE_EFFECTS_PER_KEY';END IF;
 SELECT count(*),count(*) FILTER(WHERE operation_type='transfer')
 INTO n,transfers FROM public.company_account_movement_operations
 WHERE tenant_id=1 AND operation_key IN(
   SELECT md5('D14-shared-key:'||i)::uuid FROM generate_series(1,25) AS i);
 IF n<>25 OR transfers<>5 THEN RAISE EXCEPTION 'D14_OPERATION_COUNT_BAD';END IF;
 SELECT count(*) INTO side_effects FROM public.account_transactions WHERE tenant_id=1
 AND id IN (SELECT primary_id FROM public.d14_measurements UNION
            SELECT counterpart_id FROM public.d14_measurements WHERE counterpart_id IS NOT NULL);
 IF side_effects<>30 THEN RAISE EXCEPTION 'D14_EXPECTED_30_CASH_ROWS';END IF;
 SELECT count(*) INTO audits FROM public.audit_logs
 WHERE tenant_id=1 AND metadata->>'operationKey' IN(
 SELECT (md5('D14-shared-key:'||i)::uuid)::text FROM generate_series(1,25) AS i);
 IF audits<>25 THEN RAISE EXCEPTION 'D14_EXPECTED_25_AUDITS';END IF;
 IF EXISTS(
  SELECT 1 FROM public.company_account_movement_operations op
  LEFT JOIN public.account_transactions a ON a.id=op.primary_transaction_id
  LEFT JOIN public.account_transactions b ON b.id=op.counterpart_transaction_id
  WHERE op.tenant_id=1 AND op.operation_key IN(
    SELECT md5('D14-shared-key:'||i)::uuid FROM generate_series(1,25) AS i)
   AND (a.id IS NULL OR a.tenant_id<>1 OR a.site_id<>10 OR a.amount<>1.25 OR
    (op.operation_type='transfer' AND
     (b.id IS NULL OR b.tenant_id<>1 OR b.site_id<>10
      OR a.transaction_type<>'transfer_out' OR b.transaction_type<>'transfer_in'
      OR b.amount<>a.amount)) OR
    (op.operation_type<>'transfer' AND b.id IS NOT NULL))
 ) THEN RAISE EXCEPTION 'D14_PAIRED_TRANSFER_SCOPE_INTEGRITY';END IF;
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_add_account_movement_idempotent(
   1,10,7,100,'withdrawal',2.25,'D14 source 1','D14-REF-1',
   md5('D14-shared-key:1')::uuid);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN rejected:=SQLERRM='IDEMPOTENCY_KEY_REUSED';
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'D14_CONFLICTING_REPLAY_ACCEPTED';END IF;
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_add_account_movement_idempotent(
   2,10,7,100,'deposit',1.25,'D14 foreign tenant','D14-REF-FOREIGN',
   md5('D14-shared-key:1')::uuid);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN rejected:=SQLERRM='SITE_OUT_OF_SCOPE';
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'D14_TENANT_ESCAPE';END IF;
 SELECT a.opening_balance+coalesce(sum(
  CASE WHEN t.transaction_type IN('deposit','transfer_in','collection')
  THEN t.amount ELSE -t.amount END),0) INTO cash
 FROM public.company_accounts a LEFT JOIN public.account_transactions t
 ON t.tenant_id=a.tenant_id AND t.account_id=a.id
 WHERE a.tenant_id=1 AND a.id=100 GROUP BY a.opening_balance;
 SELECT a.opening_balance+coalesce(sum(
  CASE WHEN t.transaction_type IN('deposit','transfer_in','collection')
  THEN t.amount ELSE -t.amount END),0) INTO wallet
 FROM public.company_accounts a LEFT JOIN public.account_transactions t
 ON t.tenant_id=a.tenant_id AND t.account_id=a.id
 WHERE a.tenant_id=1 AND a.id=200 GROUP BY a.opening_balance;
 SELECT coalesce(sum(amount) FILTER(WHERE transaction_type='deposit'),0),
 coalesce(sum(amount) FILTER(WHERE transaction_type='withdrawal'),0)
 INTO deposits,withdrawals FROM public.account_transactions WHERE tenant_id=1;
 IF cash+wallet<>1300000+deposits-withdrawals
 THEN RAISE EXCEPTION 'D14_ACCOUNT_BALANCES_INCONSISTENT';END IF;
 IF has_function_privilege('anon',
  'public.powerhub_add_account_movement_idempotent(bigint,bigint,bigint,bigint,text,numeric,text,text,uuid)','EXECUTE')
 OR has_function_privilege('authenticated',
  'public.powerhub_transfer_company_accounts_idempotent(bigint,bigint,bigint,bigint,bigint,numeric,text,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'D14_BROWSER_FINANCIAL_RPC_EXPOSURE';END IF;
END $proof$;

SELECT kind,count(*) AS requests,
 round(percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) AS p50_ms,
 round(percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) AS p95_ms,
 round(percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) AS p99_ms,
 max(elapsed_ms) AS max_ms
FROM public.d14_measurements GROUP BY kind ORDER BY kind;
SELECT count(*) AS requests,
 round(percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) AS p50_ms,
 round(percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) AS p95_ms,
 round(percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) AS p99_ms
FROM public.d14_measurements;
SELECT 'D14_SHARED_KEY_4_BACKENDS_25_FIRST_WRITES_75_REPLAYS_PASS';
SQL
echo "D14_LOCK_WAITERS_OBSERVED=$observed D14_NEW_DEADLOCKS=0"
