\set ON_ERROR_STOP on
DO $guard$
DECLARE n int;sessions int;first_posts int;replays int;payments int;cash_moves int;audit_count int;offline_ops int;
 paid_invoices int;overpaid int;
BEGIN
 IF current_database()<>'powerhub_b5_synthetic_collection_test'
 THEN RAISE EXCEPTION 'B5_COLLECTION_WRONG_DATABASE'; END IF;
 SELECT count(*),count(DISTINCT backend_pid),
  count(*) FILTER(WHERE NOT replay),count(*) FILTER(WHERE replay)
 INTO n,sessions,first_posts,replays FROM public.b5_collection_samples;
 IF n<>1000 OR sessions<>4 OR first_posts<>999 OR replays<>1
 THEN RAISE EXCEPTION 'B5_COLLECTION_SAMPLE_INVARIANT_FAILED % % % %',n,sessions,first_posts,replays;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.b5_collection_samples a
 JOIN public.b5_collection_samples b ON b.worker=4 AND b.iteration=250
 WHERE a.worker=1 AND a.iteration=1 AND b.replay
 AND a.payment_id=b.payment_id)
 THEN RAISE EXCEPTION 'B5_COLLECTION_REPLAY_DIFFERENT_PAYMENT';END IF;
 SELECT count(*) INTO payments FROM public.payments WHERE tenant_id=1;
 SELECT count(*) INTO cash_moves FROM public.account_transactions WHERE tenant_id=1;
 SELECT count(*) INTO audit_count FROM public.audit_logs WHERE tenant_id=1
  AND entity_type='payment' AND action='create';
 SELECT count(*) INTO offline_ops FROM public.offline_sync_operations WHERE tenant_id=1 AND operation_type='payment_create';
 SELECT count(*) INTO paid_invoices FROM public.invoices WHERE tenant_id=1 AND status='paid' AND balance_due=0
 AND paid_amount=total_amount;
 SELECT count(*) INTO overpaid FROM public.invoices WHERE tenant_id=1 AND
  (paid_amount>total_amount OR paid_amount<0 OR balance_due<0 OR balance_due<>total_amount-paid_amount);
 IF payments<>999 OR cash_moves<>999 OR audit_count<>999 OR offline_ops<>999 OR paid_invoices<>999 OR overpaid<>0
 THEN RAISE EXCEPTION 'B5_COLLECTION_LEDGER_MISMATCH % % % % % %',payments,cash_moves,audit_count,offline_ops,paid_invoices,overpaid; END IF;
 IF (SELECT count(*) FROM public.payments WHERE amount=1.50 AND tenant_id=1)<>5
 OR EXISTS(SELECT 1 FROM public.payments WHERE tenant_id=1 AND amount NOT IN(1,1.50))
 THEN RAISE EXCEPTION 'B5_COLLECTION_AMOUNT_PRECISION_DISTRIBUTION'; END IF;
 IF EXISTS(SELECT 1 FROM public.payments p
 LEFT JOIN public.account_transactions t ON t.tenant_id=p.tenant_id AND t.related_payment_id=p.id
 LEFT JOIN public.offline_sync_operations o ON o.tenant_id=p.tenant_id AND o.entity_id=p.id AND o.operation_type='payment_create'
 WHERE p.tenant_id=1 AND (t.id IS NULL OR t.amount<>p.amount OR t.transaction_type<>'collection'
 OR t.account_id<>301 OR o.id IS NULL OR o.client_operation_id<>p.client_operation_id))
 THEN RAISE EXCEPTION 'B5_COLLECTION_CASH_OR_OFFLINE_EVENT_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM public.payments WHERE tenant_id<>1 OR site_id<>10)
 THEN RAISE EXCEPTION 'B5_COLLECTION_TENANT_SITE_ESCAPE'; END IF;
 IF has_function_privilege('anon',
  'public.powerhub_create_payment(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid)',
  'EXECUTE')
 OR has_function_privilege('authenticated',
  'public.powerhub_create_payment(bigint,bigint,bigint,bigint,bigint,text,numeric,text,bigint,text,text,text,text,text,bigint,uuid)',
  'EXECUTE')
 THEN RAISE EXCEPTION 'B5_BROWSER_CAN_INVOKE_PAYMENT_RPC'; END IF;

 BEGIN
  PERFORM public.powerhub_create_payment(1,10,7,10001,10001,'B5-COL-1',2,'cash',301,NULL,NULL,
   'B5-REF-1',NULL,NULL,NULL,md5('B5-collection:1')::uuid);
  RAISE EXCEPTION 'B5_FORGED_PAYMENT_REPLAY_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'PAYMENT_OPERATION_SCOPE_CONFLICT' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.powerhub_create_payment(1,10,7,11000,11000,'B5-COL-OVERPAY',2,'cash',301,NULL,NULL,
   'B5-BAD-OVERPAY',NULL,NULL,NULL,md5('B5-collection:overpay')::uuid);
  RAISE EXCEPTION 'B5_OVERPAID_INVOICE_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'INVOICE_BALANCE_CONFLICT' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.powerhub_create_payment(2,10,7,10001,10001,'B5-COL-FOREIGN',1,'cash',301,NULL,NULL,
   'B5-BAD-TENANT',NULL,NULL,NULL,md5('B5-collection:foreign')::uuid);
  RAISE EXCEPTION 'B5_CROSS_TENANT_PAYMENT_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM NOT IN ('SUBSCRIBER_OUT_OF_SCOPE_OR_INACTIVE','COMPANY_ACCOUNT_NOT_FOUND')
    THEN RAISE; END IF;
 END;
 IF (SELECT count(*) FROM public.payments WHERE tenant_id=1)<>999
 OR (SELECT count(*) FROM public.account_transactions WHERE tenant_id=1)<>999
 OR (SELECT count(*) FROM public.audit_logs WHERE tenant_id=1 AND action='create')<>999
 THEN RAISE EXCEPTION 'B5_COLLECTION_REJECTED_REQUEST_LEFT_SIDE_EFFECTS'; END IF;
END $guard$;
SELECT count(*) request_count,
 round(percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) p50_ms,
 round(percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p95_ms,
 round(percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p99_ms,
 max(elapsed_ms) max_ms
FROM public.b5_collection_samples;
SELECT 'B5_COLLECTION_1000_CALLS_999_POSTED_1_REPLAY_FOUR_BACKENDS_PASS' AS result;
