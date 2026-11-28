-- B4.12 Staging-only, side-effect-free GL reversal provenance test.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $accept$
DECLARE v text; a jsonb; b jsonb; c jsonb; en bigint; li bigint; bad boolean:=false;
BEGIN
 SELECT count(*) INTO en FROM public.financial_gl_entries WHERE tenant_id=1;
 SELECT count(*) INTO li FROM public.financial_gl_lines WHERE tenant_id=1;
 IF en<>25 OR li<>51 THEN RAISE EXCEPTION 'B412_STAGING_BASELINE_DRIFT'; END IF;
 v:=public.powerhub_financial_gl_reversal_source_proof(1,9000000000099,169,170);
 IF v<>'SOURCE_BACKED_REVERSAL_VALID' THEN RAISE EXCEPTION 'B412_ACCRUAL_PROOF: %',v; END IF;
 v:=public.powerhub_financial_gl_reversal_source_proof(1,9000000000099,168,890);
 IF v<>'GL_INVERSE_ONLY_SOURCE_UNATTESTED' THEN RAISE EXCEPTION 'B412_UNATTESTED_OPENING: %',v; END IF;
 v:=public.powerhub_financial_gl_reversal_source_proof(1,9000000000099,169,890);
 IF v<>'BLOCKED_INTEGRITY' THEN RAISE EXCEPTION 'B412_CROSS_SOURCE_FORGERY'; END IF;
 v:=public.powerhub_financial_gl_reversal_source_proof(1,1,169,170);
 IF v<>'BLOCKED_INTEGRITY' THEN RAISE EXCEPTION 'B412_CROSS_SITE_LEAK'; END IF;
 a:=public.powerhub_financial_gl_correction_readiness(1,9000000000099,'2026-09',25,NULL);
 b:=public.powerhub_financial_gl_correction_readiness(1,9000000000099,'2026-10',25,NULL);
 c:=public.powerhub_financial_gl_correction_readiness(1,9000000000099,'2026-01',25,NULL);
 IF a->'items'->0->>'status'<>'ALREADY_REVERSED'
    OR b->'items'->0->>'status'<>'REVERSAL_ENTRY_IMMUTABLE'
    OR c->'items'->0->>'status'<>'EXISTING_REVERSAL_SOURCE_REVIEW_REQUIRED'
    OR a->>'accountingCertification'<>'NOT_CERTIFIED'
    OR c->>'glOnlyReversalAllowed'<>'false'
 THEN RAISE EXCEPTION 'B412_READINESS_CLASSIFICATION_DRIFT'; END IF;
 BEGIN
   PERFORM public.powerhub_financial_gl_correction_readiness(1,9000000000099,'2026-11',51,NULL);
 EXCEPTION WHEN SQLSTATE '22023' THEN bad:=true;END;
 IF NOT bad THEN RAISE EXCEPTION 'B412_PAGINATION_BOUND_FAIL';END IF;
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>en
    OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>li
 THEN RAISE EXCEPTION 'B412_LEDGER_CHANGED'; END IF;
END;$accept$;
SELECT 'B412_REVERSAL_PROVENANCE_GUARD_PASS_ROLLBACK' AS result;
ROLLBACK;