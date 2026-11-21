DO $assert$
BEGIN
 IF (SELECT count(*) FROM public.payments)<>9
 OR (SELECT sum(amount) FROM public.payments)<>379
 OR (SELECT count(*) FROM public.subscriber_balance_ledger)<>1
 OR (SELECT count(*) FROM public.audit_logs)<>0
 THEN RAISE EXCEPTION 'PR359_ROLLBACK_LEFT_PARTIAL_FINANCIAL_EFFECT'; END IF;
 IF (SELECT count(*) FROM public.payments WHERE id IN (2,6,9)
 AND payment_purpose='invoice_collection' AND invoice_applied_amount=amount)<>3
 OR (SELECT invoice_applied_amount FROM public.payments WHERE id=4)<>31
 THEN RAISE EXCEPTION 'PR359_ROLLBACK_LEFT_UNCOMMITTED_PAYMENT_MUTATION'; END IF;
END $assert$;
SELECT 'PR359_FULL_SOURCE_TRANSACTION_ROLLBACK_PASS';
