\set ON_ERROR_STOP on
DO $assert$
DECLARE sample_count int; session_count int; unique_posts int; replay_count int;
 purchase_count int; payment_count int; receipt_count int;stock_count int;debit_count int;
 ledger_purchases int; ledger_payments int;allocation_count int;
 cash_total numeric; supplier_total numeric;
BEGIN
 IF current_database()<>'inventory_purchase_receiving_test'
 THEN RAISE EXCEPTION 'B5_SUPPLIER_WRONG_DATABASE';END IF;
 SELECT count(*),count(DISTINCT backend_pid),
 count(*) FILTER(WHERE NOT replay),count(*) FILTER(WHERE replay)
 INTO sample_count,session_count,unique_posts,replay_count FROM public.b5_supplier_load_samples;
 IF sample_count<>100 OR session_count<>4 OR unique_posts<>99 OR replay_count<>1
 THEN RAISE EXCEPTION 'B5_SUPPLIER_100_99_1_FOUR_SESSIONS_FAILED % % % %',
 sample_count,session_count,unique_posts,replay_count;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.b5_supplier_load_samples a
 JOIN public.b5_supplier_load_samples b ON a.purchase_id=b.purchase_id
   AND a.payment_id=b.payment_id
 WHERE a.worker=1 AND a.iteration=1 AND b.worker=4 AND b.iteration=25 AND b.replay)
 THEN RAISE EXCEPTION 'B5_SUPPLIER_REPLAY_NOT_IDENTICAL'; END IF;

 SELECT count(*) INTO purchase_count FROM public.supplier_purchases
 WHERE tenant_id=10 AND site_id=100 AND operation_key LIKE 'b5:supplier:create:%';
 SELECT count(*) INTO payment_count FROM public.supplier_payments
 WHERE tenant_id=10 AND site_id=100 AND operation_key LIKE 'b5:supplier:payment:%';
 SELECT count(*) INTO receipt_count FROM public.supplier_purchase_receipts
 WHERE tenant_id=10 AND site_id=100 AND operation_key LIKE 'b5:supplier:receipt:%';
 SELECT count(*) INTO stock_count FROM public.inventory_stock_movements m
 JOIN public.supplier_purchases p ON p.tenant_id=m.tenant_id AND p.id=m.purchase_id
 WHERE p.operation_key LIKE 'b5:supplier:create:%' AND m.movement_type='purchase_receipt';
 SELECT count(*) INTO ledger_purchases FROM public.supplier_ledger_entries s
 JOIN public.supplier_purchases p ON p.tenant_id=s.tenant_id AND p.id=s.purchase_id
 WHERE p.operation_key LIKE 'b5:supplier:create:%' AND s.entry_type='purchase';
 SELECT count(*) INTO ledger_payments FROM public.supplier_ledger_entries s
 JOIN public.supplier_payments p ON p.tenant_id=s.tenant_id AND p.id=s.supplier_payment_id
 WHERE p.operation_key LIKE 'b5:supplier:payment:%' AND s.entry_type='payment';
 SELECT count(*) INTO debit_count FROM public.account_transactions a
 JOIN public.supplier_payments p ON p.tenant_id=a.tenant_id AND p.id=a.related_supplier_payment_id
 WHERE p.operation_key LIKE 'b5:supplier:payment:%'
 AND a.transaction_type='withdrawal' AND a.account_id=1000 AND a.amount=p.amount;
 SELECT count(*) INTO allocation_count FROM public.supplier_payment_allocations a
 JOIN public.supplier_payments p ON p.tenant_id=a.tenant_id AND p.id=a.payment_id
 WHERE p.operation_key LIKE 'b5:supplier:payment:%' AND a.amount=p.amount;
 IF purchase_count<>99 OR payment_count<>99 OR receipt_count<>99 OR stock_count<>99
 OR ledger_purchases<>99 OR ledger_payments<>99 OR debit_count<>99 OR allocation_count<>99
 THEN RAISE EXCEPTION 'B5_SUPPLIER_LINKAGE_COUNTS % % % % % % % %',
 purchase_count,payment_count,receipt_count,stock_count,
 ledger_purchases,ledger_payments,debit_count,allocation_count;END IF;
 IF EXISTS(SELECT 1 FROM public.supplier_purchases p
 JOIN public.supplier_payments sp ON sp.tenant_id=p.tenant_id
 JOIN public.supplier_payment_allocations a ON a.tenant_id=p.tenant_id
   AND a.purchase_id=p.id AND a.payment_id=sp.id
 WHERE p.operation_key LIKE 'b5:supplier:create:%'
 AND (p.status<>'received' OR sp.status<>'posted' OR
 sp.amount<>p.total_amount OR a.amount<>p.total_amount))
 THEN RAISE EXCEPTION 'B5_SUPPLIER_RECEIPT_PAYABLE_OR_PAYMENT_MISMATCH';END IF;
 SELECT coalesce(sum(total_amount),0) INTO supplier_total FROM public.supplier_purchases
 WHERE tenant_id=10 AND operation_key LIKE 'b5:supplier:create:%';
 SELECT coalesce(sum(amount),0) INTO cash_total FROM public.supplier_payments
 WHERE tenant_id=10 AND operation_key LIKE 'b5:supplier:payment:%';
 IF supplier_total<>99.5 OR cash_total<>supplier_total
 THEN RAISE EXCEPTION 'B5_SUPPLIER_CASH_PURCHASE_SUM_DIFF % %',supplier_total,cash_total;END IF;

 IF has_function_privilege('anon',
  'public.powerhub_inventory_record_supplier_payment(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text)',
  'EXECUTE')
 OR has_function_privilege('authenticated',
  'public.powerhub_inventory_record_supplier_payment(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text)',
  'EXECUTE')
 THEN RAISE EXCEPTION 'B5_SUPPLIER_PAYMENT_RPC_EXPOSED_TO_BROWSER'; END IF;
END $assert$;

-- Fault injection after the workload: a previously posted payment cannot be
-- reissued under its original idempotency key with different financial data.
-- All attempted writes must roll back and leave the 99 linked source records unchanged.
DO $negative$
DECLARE v_purchase bigint;v_payment bigint;v_before bigint;v_after bigint;
BEGIN
 IF current_database()<>'inventory_purchase_receiving_test'
 THEN RAISE EXCEPTION 'B5_SUPPLIER_NEGATIVE_WRONG_DATABASE'; END IF;
 SELECT purchase_id,payment_id INTO v_purchase,v_payment
 FROM public.b5_supplier_load_samples WHERE worker=1 AND iteration=1;
 SELECT count(*) INTO v_before FROM public.supplier_payments p
 WHERE p.tenant_id=10 AND p.operation_key LIKE 'b5:supplier:payment:%';
 BEGIN
  PERFORM public.powerhub_inventory_record_supplier_payment(
   10,100,2,v_purchase,1000,2,current_date,'B5-SUP-PAY-1',
   'Synthetic supplier payment','b5:supplier:payment:1');
  RAISE EXCEPTION 'B5_SUPPLIER_FORGED_REPLAY_ACCEPTED' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'IDEMPOTENCY_KEY_REUSED' THEN RAISE; END IF;
 END;
 SELECT count(*) INTO v_after FROM public.supplier_payments p
 WHERE p.tenant_id=10 AND p.operation_key LIKE 'b5:supplier:payment:%';
 IF v_after<>v_before OR v_before<>99
 OR (SELECT amount FROM public.supplier_payments WHERE id=v_payment)<>1
 THEN RAISE EXCEPTION 'B5_SUPPLIER_FORGED_REPLAY_LEFT_FINANCIAL_EFFECT'; END IF;
END $negative$;
SELECT 'B5_SUPPLIER_FORGED_REPLAY_ROLLBACK_PASS' AS result;

SELECT count(*) samples,
 round(percentile_cont(.5) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) p50_ms,
 round(percentile_cont(.95) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p95_ms,
 round(percentile_cont(.99) WITHIN GROUP(ORDER BY elapsed_ms)::numeric,2) sample_p99_ms,
 max(elapsed_ms) max_ms
FROM public.b5_supplier_load_samples;
SELECT 'B5_SUPPLIER_100_PURCHASE_RECEIPT_PAYMENT_99_FIRST_1_REPLAY_PASS' AS result;
