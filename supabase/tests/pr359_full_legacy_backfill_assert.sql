-- Run after first execution and again after replay: quantities must remain unchanged.
DO $assert$
DECLARE n bigint; gross numeric; applied numeric; credit numeric;
BEGIN
 SELECT count(*),sum(amount),sum(invoice_applied_amount),sum(subscriber_credit_amount)
 INTO n,gross,applied,credit FROM public.payments;
 IF n<>9 OR gross<>379 OR applied<>128 OR credit<>194
 THEN RAISE EXCEPTION 'CASH_CONSERVATION_FAILED %,%,%,%',n,gross,applied,credit; END IF;
 SELECT count(*) INTO n FROM public.subscriber_balance_ledger;
 IF n<>5 THEN RAISE EXCEPTION 'DUPLICATED_OR_MISSING_CREDIT_RECEIPTS: %',n; END IF;
 SELECT count(*) INTO n FROM public.audit_logs;
 IF n<>3 THEN RAISE EXCEPTION 'DUPLICATED_OR_MISSING_AUDITS: %',n; END IF;
 SELECT count(*) INTO n FROM public.subscriber_balance_ledger l
 JOIN public.payments p ON p.id=l.payment_id AND p.tenant_id=l.tenant_id
 AND p.site_id=l.site_id AND p.subscriber_id=l.subscriber_id AND p.amount=l.amount
 WHERE l.balance_type='available_credit' AND l.entry_type='receipt' AND l.direction='credit';
 IF n<>5 THEN RAISE EXCEPTION 'CROSS_SCOPE_OR_UNBALANCED_RECEIPTS'; END IF;
 SELECT count(*) INTO n FROM public.payments
 WHERE id IN (2,4,5,6,9) AND payment_purpose='subscriber_credit'
 AND invoice_applied_amount=0 AND subscriber_credit_amount=amount;
 IF n<>5 THEN RAISE EXCEPTION 'RECLASSIFICATION_INCOMPLETE: %',n; END IF;
 IF (SELECT invoice_applied_amount FROM public.payments WHERE id=1)<>120
 OR (SELECT payment_purpose FROM public.payments WHERE id=3)<>'invoice_collection'
 OR (SELECT payment_purpose FROM public.payments WHERE id=7)<>'invoice_collection'
 OR (SELECT invoice_applied_amount FROM public.payments WHERE id=8)<>8
 THEN RAISE EXCEPTION 'UNRELATED_PAYMENT_WAS_CHANGED'; END IF;
END $assert$;
SELECT 'PR359_LEGACY_FULL_MIGRATION_REPLAY_PASS';
