-- B5.1 synthetic-Staging-only negative gate; all DDL is rolled back.
-- Fail closed when the known fixture write-freeze trigger is disabled, and
-- confirm forbidden tenant/site inputs never inherit test-cohort exemptions.
BEGIN;
SET LOCAL statement_timeout='90000ms';
DO $qa$
DECLARE before_status jsonb;disabled_status jsonb;after_status jsonb;other_site jsonb;
BEGIN
 before_status:=public.powerhub_financial_gl_fast_staging_fixture_proof(1,1);
 other_site:=public.powerhub_financial_gl_fast_staging_fixture_proof(1,9000000000099);
 IF before_status->>'verified'<>'true'
 OR (before_status->>'quarantinedCount')::bigint<>250000
 OR before_status->>'humanReviewed'<>'false'
 OR before_status->>'financialCertification'<>'NOT_CERTIFIED'
 OR other_site->>'verified'<>'false'
 OR (other_site->>'quarantinedCount')::bigint<>0
 THEN RAISE EXCEPTION 'B5_1_FAST_PROOF_PRECHECK_FAILED'; END IF;

 EXECUTE 'ALTER TABLE public.account_transactions DISABLE TRIGGER powerhub_financial_gl_fixture_freeze_write';
 disabled_status:=public.powerhub_financial_gl_fast_staging_fixture_proof(1,1);
 IF disabled_status->>'verified'<>'false'
 OR (disabled_status->>'quarantinedCount')::bigint<>0
 THEN RAISE EXCEPTION 'B5_1_PROOF_NOT_BLOCKED_WITH_DISABLED_FREEZE'; END IF;
 EXECUTE 'ALTER TABLE public.account_transactions ENABLE TRIGGER powerhub_financial_gl_fixture_freeze_write';
 after_status:=public.powerhub_financial_gl_fast_staging_fixture_proof(1,1);
 IF after_status->>'verified'<>'true'
 THEN RAISE EXCEPTION 'B5_1_PROOF_NOT_RESTORED'; END IF;
 IF has_function_privilege('anon',
    'public.powerhub_financial_gl_fast_staging_fixture_proof(bigint,bigint)','EXECUTE')
 OR has_function_privilege('authenticated',
    'public.powerhub_financial_gl_fast_staging_fixture_proof(bigint,bigint)','EXECUTE')
 OR NOT has_function_privilege('service_role',
    'public.powerhub_financial_gl_fast_staging_fixture_proof(bigint,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'B5_1_FAST_PROOF_BROWSER_EXECUTE_EXPOSED'; END IF;
END;$qa$;
SELECT 'B5_1_FAST_PROOF_FAILURE_CLOSED_PASS' result;
ROLLBACK;
