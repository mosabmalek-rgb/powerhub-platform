-- B4.6 synthetic Staging; the NOT-CERTIFIED opening MUST reject evidence.
-- A real balance proof cannot be fabricated for a synthetic unsupported opening.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $qa$
DECLARE denied boolean:=false;status_json jsonb;balance_json jsonb;
  baseline_evidence bigint;baseline_custody bigint;baseline_gl bigint;
BEGIN
 SELECT count(*) INTO baseline_evidence FROM public.financial_gl_opening_evidence
  WHERE tenant_id=1 AND site_id=9000000000099;
 SELECT count(*) INTO baseline_custody FROM public.financial_gl_opening_document_custody
  WHERE tenant_id=1 AND site_id=9000000000099;
 SELECT count(*) INTO baseline_gl FROM public.financial_gl_entries WHERE tenant_id=1;
 IF baseline_evidence<>0 OR baseline_custody<>0 OR baseline_gl<>25
 THEN RAISE EXCEPTION 'B4_6_FIXTURE_BASELINE_CHANGED'; END IF;
 BEGIN
  PERFORM public.powerhub_financial_gl_opening_evidence_submit(
   1,9000000000099,19,50,'company_account_statement',
   'B4-6-UNVERIFIED-SYNTHETIC-REFERENCE',repeat('a',64),
   '2026-01-01'::date,'debit',2000,4);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  IF SQLERRM='GL_OPENING_EVIDENCE_SOURCE_OR_SCOPE_INVALID' THEN denied:=true;
  ELSE RAISE;END IF;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'B4_6_FALSE_EVIDENCE_ACCEPTED'; END IF;
 status_json:=public.powerhub_financial_gl_opening_evidence_status(1,9000000000099,'2026-11');
 balance_json:=public.powerhub_financial_gl_subledger_reconciliation(1,9000000000099,'2026-11');
 IF (status_json->>'allLinesAttested')::boolean IS DISTINCT FROM false
    OR (status_json->>'isIndependentlyReconciled')::boolean IS DISTINCT FROM false
    OR balance_json->>'status'<>'MATCHED_NUMERICALLY_NOT_CERTIFIED'
    OR (balance_json->>'differenceCount')::bigint<>0
    OR (SELECT count(*) FROM public.financial_gl_opening_evidence
        WHERE tenant_id=1 AND site_id=9000000000099)<>baseline_evidence
    OR (SELECT count(*) FROM public.financial_gl_opening_document_custody
        WHERE tenant_id=1 AND site_id=9000000000099)<>baseline_custody
    OR (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>baseline_gl
 THEN RAISE EXCEPTION 'B4_6_UNDOCUMENTED_OPENING_WAS_CERTIFIED'; END IF;
END;$qa$;
SELECT 'B4_6_MARKED_OPENING_FAIL_CLOSED_PASS_ROLLBACK' result;
ROLLBACK;