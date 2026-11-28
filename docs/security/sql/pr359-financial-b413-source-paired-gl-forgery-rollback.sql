-- B4.13: same-source GL line binding, and fail-closed forged-but-balanced counterexample.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $env$
BEGIN
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1)<>25
    OR (SELECT count(*) FROM public.financial_gl_lines WHERE tenant_id=1)<>51
    OR (SELECT count(*) FROM pg_trigger
       WHERE tgrelid='public.financial_gl_lines'::regclass
         AND tgname='financial_gl_lines_immutable' AND tgenabled='O')<>1
 THEN RAISE EXCEPTION 'B413_STAGING_BASELINE_OR_IMMUTABILITY_DRIFT'; END IF;
 IF public.powerhub_financial_gl_reversal_source_proof(1,9000000000099,169,170)
    <> 'SOURCE_BACKED_REVERSAL_VALID'
 THEN RAISE EXCEPTION 'B413_GENUINE_ACCRUAL_REJECTED'; END IF;
END $env$;
ALTER TABLE public.financial_gl_lines DISABLE TRIGGER financial_gl_lines_immutable;
-- Forge the two journal GLs symmetrically; each still balances and exactly inverts.
UPDATE public.financial_gl_lines SET account_code='1010'
 WHERE tenant_id=1 AND site_id=9000000000099 AND entry_id IN (169,170)
   AND account_code='5100';
DO $adversarial$
BEGIN
 IF public.powerhub_financial_gl_reversal_source_proof(1,9000000000099,169,170)
    <> 'BLOCKED_INTEGRITY'
 THEN RAISE EXCEPTION 'B413_FORGED_BALANCED_PAIR_ACCEPTED'; END IF;
 IF (public.powerhub_financial_gl_correction_readiness(1,9000000000099,'2026-09',25,NULL)
   ->'items'->0->>'status') <> 'EXISTING_REVERSAL_INTEGRITY_BLOCKED'
 THEN RAISE EXCEPTION 'B413_FORGED_PAIR_UI_STATUS_NOT_BLOCKED'; END IF;
END $adversarial$;
SELECT 'B413_BALANCED_BUT_SOURCE_FORGED_GL_REJECTED_PASS_ROLLBACK' AS result;
ROLLBACK;