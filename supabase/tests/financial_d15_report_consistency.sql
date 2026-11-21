-- D15 disposable PostgreSQL 17 reporting contract.
-- Uses the actual A3 coverage and A4 trial-balance migrations already
-- installed by financial_gl_atomic_accrual_posting.sql in the SAME CI database.
-- No mocked RPCs, no Production/Staging writes, and no certification claims.
\set ON_ERROR_STOP on
DO $preflight$
BEGIN
 IF current_database()<>'financial_gl_atomic_accrual_test'
    OR to_regclass('public.financial_gl_entries') IS NULL
    OR to_regclass('public.invoices') IS NULL
 THEN RAISE EXCEPTION 'D15_DISPOSABLE_GL_FIXTURE_REQUIRED'; END IF;
END $preflight$;

BEGIN;
INSERT INTO public.invoices(
 id,tenant_id,site_id,status,cycle_start_at,cycle_end_at,issue_date,total_amount,tax_amount
) VALUES
 (201,901,9101,'issued','2026-10-01T00:00:00Z','2026-10-31T00:00:00Z','2026-10-31T01:00:00Z',31.25,0),
 (202,902,9201,'issued','2026-10-01T00:00:00Z','2026-10-31T00:00:00Z','2026-10-31T01:00:00Z',14.75,0);

DO $d15$
DECLARE coverage jsonb;trial jsonb;other jsonb;denied boolean:=false;
BEGIN
 coverage:=public.powerhub_financial_gl_source_coverage(901,9101,'2026-10');
 trial:=public.powerhub_financial_gl_trial_balance(901,9101,'2026-10');
 other:=public.powerhub_financial_gl_source_coverage(902,9201,'2026-10');
 IF (coverage->'sources'->'invoices'->>'missingGL')::bigint<>1
    OR (coverage->'sources'->'invoices'->>'inScope')::bigint<>1
    OR (coverage->>'unreconciledSourceCount')::bigint<1
    OR coverage->>'isSourceCoverageComplete' IS DISTINCT FROM 'false'
    OR coverage->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
 THEN RAISE EXCEPTION 'D15_MISSING_SOURCE_SILENTLY_ACCEPTED'; END IF;
 IF (other->'sources'->'invoices'->>'missingGL')::bigint<>1
    OR (other->'sources'->'invoices'->>'inScope')::bigint<>1
    OR other->>'tenantId' IS DISTINCT FROM '902'
    OR other->>'siteId' IS DISTINCT FROM '9201'
 THEN RAISE EXCEPTION 'D15_FOREIGN_TENANT_SOURCE_LEAKED'; END IF;
 -- The ledger remains mathematically balanced despite a missing invoice GL.
 -- That must NOT be rendered as a final balance sheet or certification.
 IF trial->>'tenantId' IS DISTINCT FROM '901'
    OR trial->>'siteId' IS DISTINCT FROM '9101'
    OR trial->>'throughPeriod' IS DISTINCT FROM '2026-10'
    OR trial->>'isMathematicallyBalanced' IS DISTINCT FROM 'true'
    OR (trial->>'difference')::numeric<>0
    OR trial->>'isSourceCoverageComplete' IS DISTINCT FROM 'false'
    OR trial->>'isFinalBalanceSheet' IS DISTINCT FROM 'false'
    OR trial->>'isCompleteAccrualStatement' IS DISTINCT FROM 'false'
    OR trial->>'accountingCertification' IS DISTINCT FROM 'NOT_CERTIFIED'
    OR (trial->'sourceCoverage'->'sources'->'invoices'->>'missingGL')::bigint<>1
 THEN RAISE EXCEPTION 'D15_BALANCED_GL_FALSE_CERTIFICATION'; END IF;
 BEGIN
   PERFORM public.powerhub_financial_gl_trial_balance(902,9101,'2026-10');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'D15_CROSS_TENANT_REPORT_ACCEPTED'; END IF;
 denied:=false;
 BEGIN
   PERFORM public.powerhub_financial_gl_source_coverage(901,9101,'2026-13');
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'D15_INVALID_PERIOD_ACCEPTED'; END IF;
 IF has_function_privilege('anon',
    'public.powerhub_financial_gl_trial_balance(bigint,bigint,text)','EXECUTE')
    OR has_function_privilege('authenticated',
      'public.powerhub_financial_gl_source_coverage(bigint,bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'D15_BROWSER_REPORT_RPC_PRIVILEGE'; END IF;
END $d15$;
ROLLBACK;

DO $cleanup$
BEGIN
 IF EXISTS(SELECT 1 FROM public.invoices WHERE id IN(201,202))
 THEN RAISE EXCEPTION 'D15_ROLLBACK_LEFT_TEST_INVOICE'; END IF;
END $cleanup$;
SELECT 'D15_DISPOSABLE_MISSING_GL_BALANCED_TRIAL_FAIL_CLOSED_PASS' AS result;
