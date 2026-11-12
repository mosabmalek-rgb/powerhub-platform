BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $baseline$ BEGIN
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>51
 OR NOT EXISTS(SELECT 1 FROM public.supplier_payments WHERE tenant_id=1 AND site_id=1 AND id=5 AND status='posted')
 THEN RAISE EXCEPTION 'B414_BASELINE_DRIFT'; END IF;
END $baseline$;

DO $qa$
DECLARE denied_flexible boolean:=false;denied_original boolean:=false;
 gl_before bigint; gl_after bigint; tx_before bigint;tx_after bigint;ledger_before bigint;ledger_after bigint;
BEGIN
 SELECT count(*) INTO gl_before FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO tx_before FROM public.account_transactions WHERE tenant_id=1 AND reference_no='REV-SUPPLIER-PAYMENT-5';
 SELECT count(*) INTO ledger_before FROM public.supplier_ledger_entries WHERE tenant_id=1 AND entry_key='supplier-payment-reversal:5';
 BEGIN
  PERFORM public.powerhub_inventory_reverse_supplier_payment_flexible(1,1,3,5,'B4.14 deny operational-only reversal after financial GL posted');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied_flexible:=true;
 END;
 BEGIN
  PERFORM public.powerhub_inventory_reverse_supplier_payment(1,1,3,5,'B4.14 deny operational-only reversal after financial GL posted');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied_original:=true;
 END;
 SELECT count(*) INTO gl_after FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO tx_after FROM public.account_transactions WHERE tenant_id=1 AND reference_no='REV-SUPPLIER-PAYMENT-5';
 SELECT count(*) INTO ledger_after FROM public.supplier_ledger_entries WHERE tenant_id=1 AND entry_key='supplier-payment-reversal:5';
 IF NOT denied_flexible OR NOT denied_original OR gl_before<>gl_after OR tx_before<>tx_after OR ledger_before<>ledger_after
 THEN RAISE EXCEPTION 'B414_POSTED_PAYMENT_REVERSAL_NOT_ATOMICALLY_BLOCKED'; END IF;
END $qa$;
SELECT 'B414_SUPPLIER_GL_REVERSAL_REQUIRED_FAIL_CLOSED_PASS_ROLLBACK' AS result;
ROLLBACK;