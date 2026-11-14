\set ON_ERROR_STOP on
DO $guard$
DECLARE n int;sessions int;first_posts int;replays int;
 expenses int;cash_moves int;audit_count int;offline_ops int;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_expense_test'
 THEN RAISE EXCEPTION 'B5_EXPENSE_WRONG_DATABASE'; END IF;
 SELECT count(*),count(DISTINCT backend_pid),
  count(*) FILTER(WHERE NOT replay),count(*) FILTER(WHERE replay)
 INTO n,sessions,first_posts,replays FROM public.b5_expense_samples;
 IF n<>1000 OR sessions<>4 OR first_posts<>999 OR replays<>1
 THEN RAISE EXCEPTION 'B5_EXPENSE_SAMPLE_INVARIANT % % % %',n,sessions,first_posts,replays;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.b5_expense_samples a
 JOIN public.b5_expense_samples b ON b.worker=4 AND b.iteration=250
 WHERE a.worker=1 AND a.iteration=1 AND b.replay
 AND a.expense_id=b.expense_id AND a.transaction_id=b.transaction_id)
 THEN RAISE EXCEPTION 'B5_EXPENSE_REPLAY_DIFFERENT_SOURCE'; END IF;
 SELECT count(*) INTO expenses FROM public.expenses WHERE tenant_id=1;
 SELECT count(*) INTO cash_moves FROM public.account_transactions WHERE tenant_id=1;
 SELECT count(*) INTO audit_count FROM public.audit_logs WHERE tenant_id=1 AND action='create' AND entity_type='expense';
 SELECT count(*) INTO offline_ops FROM public.powerhub_expense_offline_operation_results WHERE tenant_id=1;
 IF expenses<>999 OR cash_moves<>999 OR audit_count<>999 OR offline_ops<>999
 THEN RAISE EXCEPTION 'B5_EXPENSE_SIDE_EFFECT_COUNTS % % % %',expenses,cash_moves,audit_count,offline_ops; END IF;
 IF (SELECT count(*) FROM public.expenses WHERE amount=1.5 AND tenant_id=1)<>5
 OR EXISTS(SELECT 1 FROM public.expenses WHERE tenant_id=1 AND amount NOT IN(1,1.5))
 THEN RAISE EXCEPTION 'B5_EXPENSE_DECIMAL_DISTRIBUTION'; END IF;
 IF EXISTS(SELECT 1 FROM public.expenses e
 LEFT JOIN public.account_transactions t ON t.tenant_id=e.tenant_id AND t.related_expense_id=e.id
 LEFT JOIN public.powerhub_expense_offline_operation_results o ON o.tenant_id=e.tenant_id AND o.expense_id=e.id
 WHERE e.tenant_id=1 AND (t.id IS NULL OR t.amount<>e.amount OR t.transaction_type<>'withdrawal'
 OR t.account_id<>301 OR o.transaction_id IS DISTINCT FROM t.id
 OR e.expense_classification<>'operating'))
 THEN RAISE EXCEPTION 'B5_EXPENSE_CASH_PROVENANCE'; END IF;
 IF EXISTS(SELECT 1 FROM public.expenses WHERE tenant_id<>1 OR site_id<>10)
 THEN RAISE EXCEPTION 'B5_EXPENSE_TENANT_SITE_ESCAPE'; END IF;
 IF has_function_privilege('anon',
 'public.powerhub_create_expense_classified_idempotent(bigint,bigint,bigint,bigint,bigint,text,text,numeric,text,uuid,text)',
 'EXECUTE')
 OR has_function_privilege('authenticated',
 'public.powerhub_create_expense_classified_idempotent(bigint,bigint,bigint,bigint,bigint,text,text,numeric,text,uuid,text)',
 'EXECUTE')
 THEN RAISE EXCEPTION 'B5_BROWSER_CAN_INVOKE_EXPENSE_RPC'; END IF;
 BEGIN
 PERFORM public.powerhub_create_expense_classified_idempotent(1,10,7,15,301,'fuel',
  'B5 synthetic expense number 1',2,'B5-EXP-1',md5('B5-expense:1')::uuid,'operating');
 RAISE EXCEPTION 'B5_FORGED_EXPENSE_REPLAY_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'IDEMPOTENCY_KEY_REUSED' THEN RAISE; END IF;
 END;
 BEGIN
 PERFORM public.powerhub_create_expense_classified_idempotent(1,10,7,15,301,'fuel',
  'B5 overdraft negative',100000000,'B5-OVERDRAW',md5('B5-expense:overdraw')::uuid,'operating');
 RAISE EXCEPTION 'B5_EXPENSE_OVERDRAFT_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'INSUFFICIENT_ACCOUNT_BALANCE' THEN RAISE; END IF;
 END;
 BEGIN
 PERFORM public.powerhub_create_expense_classified_idempotent(2,10,7,15,301,'fuel',
  'B5 foreign expense',1,'B5-FOREIGN',md5('B5-expense:foreign')::uuid,'operating');
 RAISE EXCEPTION 'B5_EXPENSE_CROSS_TENANT_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'SITE_OUT_OF_SCOPE' THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.expenses WHERE tenant_id=1)<>999
 OR (SELECT count(*) FROM public.account_transactions WHERE tenant_id=1)<>999
 OR (SELECT count(*) FROM public.audit_logs WHERE tenant_id=1 AND action='create')<>999
 THEN RAISE EXCEPTION 'B5_EXPENSE_REJECTED_REQUEST_LEFT_SIDE_EFFECTS'; END IF;
END $guard$;
SELECT count(*) request_count,
 round(percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) p50_ms,
 round(percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p95_ms,
 round(percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p99_ms,
 max(elapsed_ms) maximum_ms
FROM public.b5_expense_samples;
SELECT 'B5_EXPENSE_1000_CALLS_999_POSTED_1_REPLAY_FOUR_BACKENDS_PASS' AS result;
