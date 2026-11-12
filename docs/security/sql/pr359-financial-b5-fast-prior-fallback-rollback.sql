-- B5.3 synthetic Staging regression: optimized raw prior-gap source
-- must produce unchanged counts and fail safely when fixture freeze guard is disabled.
-- Changes to trigger state exist ONLY inside this rollback transaction.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE normal_raw jsonb;normal_prior jsonb;fallback_raw jsonb;fallback_prior jsonb;
BEGIN
 normal_raw:=public.powerhub_financial_gl_prior_operational_gaps_raw(1,1,'2026-11');
 normal_prior:=public.powerhub_financial_gl_prior_operational_gaps(1,1,'2026-11');
 IF (normal_raw->>'unclassifiedAccountMovements')::bigint<>250000
 OR (normal_raw->>'performanceFixtureTagged')::bigint<>250000
 OR (normal_prior->>'unclassifiedAccountMovements')::bigint<>0
 OR (normal_prior->>'unreconciledCount')::bigint<>0
 OR (normal_prior->>'quarantinedTestMovements')::bigint<>250000
 THEN RAISE EXCEPTION 'B5_3_FAST_BASELINE_INVALID';END IF;
 EXECUTE 'ALTER TABLE public.account_transactions DISABLE TRIGGER powerhub_financial_gl_fixture_freeze_write';
 fallback_raw:=public.powerhub_financial_gl_prior_operational_gaps_raw(1,1,'2026-11');
 fallback_prior:=public.powerhub_financial_gl_prior_operational_gaps(1,1,'2026-11');
 IF normal_raw IS DISTINCT FROM fallback_raw
 OR (fallback_prior->>'unclassifiedAccountMovements')::bigint<>250000
 OR (fallback_prior->>'unreconciledCount')::bigint<>250000
 OR (fallback_prior->>'quarantinedTestMovements') IS NOT NULL
 THEN RAISE EXCEPTION 'B5_3_FAST_PROOF_FAILED_TO_CLOSE';END IF;
 EXECUTE 'ALTER TABLE public.account_transactions ENABLE TRIGGER powerhub_financial_gl_fixture_freeze_write';
 IF (public.powerhub_financial_gl_prior_operational_gaps(1,1,'2026-11')->>'unreconciledCount')::bigint<>0
 THEN RAISE EXCEPTION 'B5_3_GUARD_REENABLE_FAILED';END IF;
END;$qa$;
SELECT 'B5_3_RAW_FALLBACK_PRESERVES_UNRESOLVED_PASS_ROLLBACK' result;
ROLLBACK;
