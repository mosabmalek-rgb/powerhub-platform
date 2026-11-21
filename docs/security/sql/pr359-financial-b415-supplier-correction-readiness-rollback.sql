-- B4.15 Staging-only source-evidence regression. Must run with BEGIN/ROLLBACK.
-- Does not mutate financial rows; tests must fail closed if the known prelaunch fixture is missing.
BEGIN;
SET LOCAL statement_timeout='50000ms';
\ir ../../../supabase/migrations/20261112191500_powerhub_financial_b415_supplier_payment_correction_preflight.sql
DO $checks$
DECLARE v jsonb; n_gl bigint; n_lines bigint; n_tx bigint; n_audit bigint; v_rejected boolean:=false;
BEGIN
 SELECT count(*) INTO n_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO n_lines FROM public.financial_gl_lines WHERE tenant_id=1;
 SELECT count(*) INTO n_tx FROM public.account_transactions WHERE tenant_id=1 AND related_supplier_payment_id=5;
 SELECT count(*) INTO n_audit FROM public.audit_logs WHERE tenant_id=1 AND entity_type='supplier_payment' AND entity_id='5';
 v:=public.powerhub_financial_supplier_payment_correction_readiness(1,1,5);
 IF v->>'status'<>'SOURCE_VERIFIED_WORKFLOW_NOT_IMPLEMENTED'
    OR (v->>'sourceEvidenceVerified')::boolean IS DISTINCT FROM true
    OR (v->>'originalGLEntryId')::bigint<>857
    OR (v->>'supplierLedgerEntryId')::bigint<>20
    OR (v->>'paymentAmount')::numeric<>210
    OR v->>'accountingCertification'<>'NOT_CERTIFIED'
    OR (v->>'canPostCorrection')::boolean IS DISTINCT FROM false
    OR (v->>'makerCheckerRequired')::boolean IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'B415_VERIFIED_SOURCE_INCORRECT: %',v; END IF;
 v:=public.powerhub_financial_supplier_payment_correction_readiness(1,1,9999999);
 IF v->>'status'<>'SUPPLIER_PAYMENT_NOT_FOUND' OR (v->>'sourceEvidenceVerified')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'B415_UNKNOWN_PAYMENT_NOT_CLOSED'; END IF;
 v:=public.powerhub_financial_supplier_payment_correction_readiness(1,9000000000099,5);
 IF v->>'status'<>'SUPPLIER_PAYMENT_NOT_FOUND' OR (v->>'canPostCorrection')::boolean IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'B415_CROSS_SITE_LEAK'; END IF;
 BEGIN PERFORM public.powerhub_financial_supplier_payment_correction_readiness(2,1,5);
 EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected:=true;
 END;
 IF NOT v_rejected THEN RAISE EXCEPTION 'B415_CROSS_TENANT_ACCEPTED'; END IF;
 IF has_function_privilege('anon','public.powerhub_financial_supplier_payment_correction_readiness(bigint,bigint,bigint)','EXECUTE')
   OR has_function_privilege('authenticated','public.powerhub_financial_supplier_payment_correction_readiness(bigint,bigint,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'B415_PUBLIC_RPC_EXPOSURE'; END IF;
 IF n_gl<>(SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)
    OR n_lines<>(SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)
    OR n_tx<>(SELECT count(*) FROM public.account_transactions WHERE tenant_id=1 AND related_supplier_payment_id=5)
    OR n_audit<>(SELECT count(*) FROM public.audit_logs WHERE tenant_id=1 AND entity_type='supplier_payment' AND entity_id='5')
 THEN RAISE EXCEPTION 'B415_PREFLIGHT_WROTE_FINANCIAL_ROWS'; END IF;
END $checks$;
SELECT 'B415_SOURCE_LINKED_READ_ONLY_NEGATIVE_PASS_ROLLBACK' result;
ROLLBACK;
