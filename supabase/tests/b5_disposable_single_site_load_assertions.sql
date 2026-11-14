\set ON_ERROR_STOP on
-- B5 post-load checks for 1000 actual account movement RPC calls (999 distinct + 1 replay).
-- Applies exclusively to disposable PostgreSQL database, never Supabase Staging/Production.
DO $b5$
DECLARE
  n integer; sessions integer; replays integer; first_posts integer;
  transfers integer; movement_ops integer; tx_rows integer; audits integer;
  cash_balance numeric; wallet_balance numeric; deposits numeric; withdrawals numeric;
  sample_p95 numeric; sample_p99 numeric;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_load_test'
 THEN RAISE EXCEPTION 'B5_DISPOSABLE_DATABASE_ONLY'; END IF;
 SELECT count(*),count(DISTINCT backend_pid),
   count(*) FILTER(WHERE replayed),count(*) FILTER(WHERE NOT replayed),
   count(*) FILTER(WHERE operation='transfer' AND NOT replayed)
 INTO n,sessions,replays,first_posts,transfers
 FROM public.b5_measurements;
 IF n<>1000 OR sessions<>4 OR replays<>1 OR first_posts<>999
 THEN RAISE EXCEPTION 'B5_1000_CALLS_4_SESSIONS_999_NEW_1_REPLAY_FAILED: % % % %',
 n,sessions,first_posts,replays; END IF;
 IF NOT EXISTS(
   SELECT 1 FROM public.b5_measurements a
   JOIN public.b5_measurements b ON a.worker_id=b.worker_id
   AND b.iteration=250 AND a.transaction_id=b.transaction_id
   WHERE a.worker_id=4 AND a.iteration=1 AND b.replayed
 ) THEN RAISE EXCEPTION 'B5_IDEMPOTENCY_REPLAY_DIFFERENT_TRANSACTION'; END IF;

 SELECT count(*) INTO movement_ops FROM public.company_account_movement_operations WHERE tenant_id=1;
 SELECT count(*) INTO tx_rows FROM public.account_transactions WHERE tenant_id=1;
 SELECT count(*) INTO audits FROM public.audit_logs WHERE tenant_id=1;
 IF movement_ops<>999 OR tx_rows<>999+transfers OR audits<>999
 THEN RAISE EXCEPTION 'B5_SIDE_EFFECTS_NOT_EXACTLY_ONCE ops=% tx=% audit=% transfers=%',
 movement_ops,tx_rows,audits,transfers; END IF;

 -- Exactly 995 requests use whole amounts, 5 requests use one decimal.
 -- The sole replay matches a whole-amount original, so all five fractional
 -- operations must create exactly five movements.
 IF (SELECT count(*) FROM public.account_transactions WHERE amount=1.5 AND tenant_id=1)<>5
 OR EXISTS(SELECT 1 FROM public.account_transactions WHERE tenant_id=1
    AND amount NOT IN (1.00,1.50))
 THEN RAISE EXCEPTION 'B5_CURRENCY_PRECISION_DISTRIBUTION_DRIFT'; END IF;

 IF EXISTS(SELECT 1 FROM public.account_transactions WHERE tenant_id<>1 OR site_id<>10)
 OR EXISTS(SELECT 1 FROM public.company_account_movement_operations WHERE tenant_id<>1 OR site_id<>10)
 THEN RAISE EXCEPTION 'B5_TENANT_SITE_ESCAPE'; END IF;

 IF EXISTS(SELECT 1 FROM public.company_account_movement_operations o
 LEFT JOIN public.account_transactions t ON t.tenant_id=o.tenant_id AND t.id=o.primary_transaction_id
 LEFT JOIN public.account_transactions u ON u.tenant_id=o.tenant_id AND u.id=o.counterpart_transaction_id
 WHERE t.id IS NULL OR t.account_id<>100
 OR (o.operation_type='transfer' AND
     (u.id IS NULL OR u.account_id<>200 OR u.transaction_type<>'transfer_in'
     OR t.transaction_type<>'transfer_out' OR u.amount<>t.amount))
 OR (o.operation_type<>'transfer' AND u.id IS NOT NULL)
 ) THEN RAISE EXCEPTION 'B5_TRANSFER_PAIR_OR_OPERATION_LINK_MISMATCH'; END IF;

 SELECT a.opening_balance+coalesce(sum(
   CASE WHEN t.transaction_type IN('deposit','transfer_in','collection')
     THEN t.amount ELSE -t.amount END),0)
 INTO cash_balance FROM public.company_accounts a
 LEFT JOIN public.account_transactions t ON t.tenant_id=a.tenant_id AND t.account_id=a.id
 WHERE a.id=100 AND a.tenant_id=1 GROUP BY a.opening_balance;
 SELECT a.opening_balance+coalesce(sum(
   CASE WHEN t.transaction_type IN('deposit','transfer_in','collection')
     THEN t.amount ELSE -t.amount END),0)
 INTO wallet_balance FROM public.company_accounts a
 LEFT JOIN public.account_transactions t ON t.tenant_id=a.tenant_id AND t.account_id=a.id
 WHERE a.id=200 AND a.tenant_id=1 GROUP BY a.opening_balance;
 SELECT coalesce(sum(amount) FILTER(WHERE transaction_type='deposit'),0),
 coalesce(sum(amount) FILTER(WHERE transaction_type='withdrawal'),0)
 INTO deposits,withdrawals FROM public.account_transactions WHERE tenant_id=1;
 IF cash_balance+wallet_balance <> 1300000+deposits-withdrawals
 THEN RAISE EXCEPTION 'B5_CASH_WALLET_RECONCILIATION_FAILED'; END IF;

 SELECT percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms),
        percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)
 INTO sample_p95,sample_p99 FROM public.b5_measurements;
 IF sample_p95>5000 OR sample_p99>10000
 THEN RAISE EXCEPTION 'B5_SYNTHETIC_SAMPLE_BUDGET_EXCEEDED p95=% p99=%',
 sample_p95,sample_p99; END IF;
END $b5$;
SELECT operation,count(*) request_count,
 round(percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) p50_ms,
 round(percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p95_ms,
 round(percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p99_ms,
 max(elapsed_ms) maximum_ms,count(*) FILTER(WHERE replayed) replay_count
FROM public.b5_measurements GROUP BY operation ORDER BY operation;

-- Post-load fault injection on the disposable database: no forged idempotency,
-- overdraft or cross-site write may add even one business or audit entry.
DO $b5_negative$
DECLARE t_before bigint; o_before bigint; a_before bigint;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_load_test'
 THEN RAISE EXCEPTION 'B5_NEGATIVE_TEST_WRONG_DATABASE'; END IF;
 SELECT count(*) INTO t_before FROM public.account_transactions WHERE tenant_id=1;
 SELECT count(*) INTO o_before FROM public.company_account_movement_operations WHERE tenant_id=1;
 SELECT count(*) INTO a_before FROM public.audit_logs WHERE tenant_id=1;

 BEGIN
  PERFORM public.powerhub_add_account_movement_idempotent(
   1,10,7,100,'deposit',2.00,'B5 fixture worker 2 operation 10',
   'B5-SYN-2-10',md5('B5-single-branch-synthetic:2:10')::uuid);
  RAISE EXCEPTION 'B5_FORGED_IDEMPOTENCY_PAYLOAD_ACCEPTED' USING ERRCODE='22023';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'IDEMPOTENCY_KEY_REUSED' THEN RAISE; END IF;
 END;

 BEGIN
  PERFORM public.powerhub_add_account_movement_idempotent(
   1,10,7,100,'withdrawal',99999999.99,'B5 synthetic overdraft','B5-NEG-OVERDRAW',
   'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid);
  RAISE EXCEPTION 'B5_OVERDRAFT_ACCEPTED' USING ERRCODE='22023';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'INSUFFICIENT_ACCOUNT_BALANCE' THEN RAISE; END IF;
 END;

 BEGIN
  PERFORM public.powerhub_add_account_movement_idempotent(
   2,10,7,100,'deposit',1.00,'B5 cross tenant injection','B5-NEG-TENANT',
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid);
  RAISE EXCEPTION 'B5_CROSS_TENANT_ACCEPTED' USING ERRCODE='22023';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'SITE_OUT_OF_SCOPE' THEN RAISE; END IF;
 END;

 IF (SELECT count(*) FROM public.account_transactions WHERE tenant_id=1)<>t_before
 OR (SELECT count(*) FROM public.company_account_movement_operations WHERE tenant_id=1)<>o_before
 OR (SELECT count(*) FROM public.audit_logs WHERE tenant_id=1)<>a_before
 THEN RAISE EXCEPTION 'B5_NEGATIVE_FAULT_INJECTION_LEFT_FINANCIAL_SIDE_EFFECTS'; END IF;

 IF has_function_privilege('anon',
    'public.powerhub_add_account_movement_idempotent(bigint,bigint,bigint,bigint,text,numeric,text,text,uuid)',
    'EXECUTE')
 OR has_function_privilege('authenticated',
    'public.powerhub_add_account_movement_idempotent(bigint,bigint,bigint,bigint,text,numeric,text,text,uuid)',
    'EXECUTE')
 THEN RAISE EXCEPTION 'B5_BROWSER_CAN_INVOKE_PRIVILEGED_FINANCIAL_RPC'; END IF;
END $b5_negative$;
SELECT 'B5_SYNTHETIC_FAULT_INJECTION_REPLAY_OVERDRAFT_TENANT_ACL_PASS' AS result;

SELECT 'B5_SYNTHETIC_SINGLE_SITE_1000_REQUESTS_999_FIRST_TIME_1_REPLAY_4_BACKENDS_PASS' AS result;
