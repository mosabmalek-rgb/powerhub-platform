-- B5.4 negative gate: losing freeze guard must reveal benchmark cohort,
-- never misreport an approved GL audit. All trigger toggles rolled back.
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $qa$
DECLARE normal jsonb; unsafe jsonb; recovered jsonb;
BEGIN
 normal:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
 IF normal->>'status'<>'LINKED_ACCOUNT_MOVEMENTS_MATCH_NOT_CERTIFIED'
 OR (normal->>'fixtureExcludedCount')::bigint<>250000
 OR normal->>'fixtureVerificationStatus'<>'HASH_ANCHORED_IMMUTABLE_TEST_COHORT'
 THEN RAISE EXCEPTION 'B54_BASELINE_NOT_VERIFIED'; END IF;
 EXECUTE 'ALTER TABLE public.account_transactions DISABLE TRIGGER powerhub_financial_gl_fixture_freeze_write';
 unsafe:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
 IF (unsafe->>'fixtureExcludedCount')::bigint<>0
 OR unsafe->>'fixtureVerificationStatus'<>'UNVERIFIED_COHORT_BLOCKS_RECONCILIATION'
 OR unsafe->>'status'<>'BLOCKED_ACCOUNT_MOVEMENT_AUDIT'
 THEN RAISE EXCEPTION 'B54_DISABLED_GUARD_NOT_BLOCKED'; END IF;
 EXECUTE 'ALTER TABLE public.account_transactions ENABLE TRIGGER powerhub_financial_gl_fixture_freeze_write';
 recovered:=public.powerhub_financial_gl_company_movement_audit(1,1,'2026-11');
 IF recovered IS DISTINCT FROM normal
 THEN RAISE EXCEPTION 'B54_GUARD_NOT_RESTORED'; END IF;
END;$qa$;
SELECT 'B54_AUDIT_FIXTURE_FAIL_CLOSED_PASS_ROLLBACK' result;
ROLLBACK;
