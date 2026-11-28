-- PR #359 D6 post-release Staging acceptance. DO NOT RUN ON PRODUCTION.
-- Run only after the exact-version 20261114203000 migration is INSTALLED.
-- Uses a temporary review with conspicuously non-accounting evidence and
-- reverses all test data changes with ROLLBACK. No persistent certification.
BEGIN;
SET LOCAL statement_timeout='35s';
SET LOCAL lock_timeout='2s';
CREATE TEMP TABLE d6_staging_results(
 test_name text PRIMARY KEY, result text NOT NULL
) ON COMMIT DROP;
DO $d6$
DECLARE
  v_evidence jsonb='{}'::jsonb;
  v_key text; v_status jsonb;
  v_before text; v_after text; v_snapshot_before jsonb; v_snapshot_after jsonb;
  v_original_gross numeric; v_original_net numeric;
BEGIN
 IF to_regprocedure('public.powerhub_financial_accrual_detail_fingerprint_v3(bigint,bigint,text)')
 IS NULL THEN RAISE EXCEPTION 'D6_MIGRATION_NOT_INSTALLED';END IF;
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews
    WHERE tenant_id=1 AND site_id=1 AND period='2026-08')
 THEN RAISE EXCEPTION 'D6_TEST_SCOPE_NOT_EMPTY';END IF;
 UPDATE public.payroll_runs SET period='2026-08'
  WHERE tenant_id=1 AND site_id=1 AND id=1 AND period='2026-10';
 IF NOT FOUND THEN RAISE EXCEPTION 'D6_STAGING_PAYROLL_MISSING';END IF;
 SELECT total_gross,total_net INTO v_original_gross,v_original_net
 FROM public.payroll_runs WHERE id=1;
 v_before:=public.powerhub_financial_accrual_detail_fingerprint_v3(1,1,'2026-08');
 UPDATE public.payroll_runs SET total_gross=total_gross+1,total_net=total_net+1
 WHERE id=1;
 v_after:=public.powerhub_financial_accrual_detail_fingerprint_v3(1,1,'2026-08');
 IF v_before=v_after THEN RAISE EXCEPTION 'D6_MISSING_POSITIVE_FINANCIAL_DRIFT';END IF;
 UPDATE public.payroll_runs
 SET total_gross=v_original_gross,total_net=v_original_net WHERE id=1;
 INSERT INTO pg_temp.d6_staging_results VALUES
  ('v3 detects real financial payroll changes','PASS');

 FOREACH v_key IN ARRAY ARRAY[
  'unbilled_service','invoice_cutoff','supplier_reconciliation',
  'inventory_reconciliation','payroll_reconciliation','depreciation_register',
  'provision_assessment','tax_reconciliation'
 ] LOOP
  v_evidence:=v_evidence||jsonb_build_object(v_key,
  'D6 TEMPORARY ROLLBACK TEST - NOT ACCOUNTING EVIDENCE');
 END LOOP;
 PERFORM public.powerhub_financial_accrual_period_save_review(
  1,1,'2026-08',2,v_evidence);
 IF (SELECT fingerprint_version FROM public.financial_accrual_period_reviews
  WHERE tenant_id=1 AND site_id=1 AND period='2026-08')<>'financial_v3'
 THEN RAISE EXCEPTION 'D6_NEW_STAGING_REVIEW_NOT_V3';END IF;
 IF (public.powerhub_financial_accrual_period_lock(1,1,'2026-08',3)
    ->>'status') IS DISTINCT FROM 'locked'
 THEN RAISE EXCEPTION 'D6_STAGING_LOCK_FAILED';END IF;
 INSERT INTO pg_temp.d6_staging_results VALUES ('new v3 C4 close','PASS');
 v_snapshot_before:=public.powerhub_financial_accrual_month_statement(
  1,1,'2026-08',now())-'asOf';
 UPDATE public.payroll_runs SET updated_at=updated_at+INTERVAL '1 second'
 WHERE id=1 AND period='2026-08';
 v_status:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-08');
 IF v_status->>'driftDetected'<>'false'
 THEN RAISE EXCEPTION 'D6_PAYROLL_METADATA_FALSE_DRIFT: %',v_status;END IF;
 INSERT INTO pg_temp.d6_staging_results VALUES ('payroll metadata does not drift','PASS');
 INSERT INTO public.account_transactions(
  tenant_id,site_id,account_id,transaction_type,amount,description,
  reference_no,occurred_at,created_by_user_id)
 VALUES(1,1,5,'deposit',0.01,'D6 cash-only test (rollback)',
  'D6-STAGING-ROLLBACK-CASH-20261114','2026-08-15 12:00+03',2);
 v_status:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-08');
 IF v_status->>'driftDetected'<>'false'
 THEN RAISE EXCEPTION 'D6_CASH_ONLY_FALSE_DRIFT: %',v_status;END IF;
 v_snapshot_after:=public.powerhub_financial_accrual_month_statement(
  1,1,'2026-08',now())-'asOf';
 IF v_snapshot_before IS DISTINCT FROM v_snapshot_after
 THEN RAISE EXCEPTION 'D6_STAGING_CASH_CHANGED_ACCRUAL_STATEMENT';END IF;
 INSERT INTO pg_temp.d6_staging_results VALUES ('cash-only deposit does not drift','PASS');
END $d6$;
SELECT * FROM pg_temp.d6_staging_results ORDER BY test_name;
ROLLBACK;

-- Second, independent read-only query must show:
-- original payroll period = 2026-10;
-- 0 review rows for tenant=1, site=1, period=2026-08;
-- 0 account_transactions with reference_no='D6-STAGING-ROLLBACK-CASH-20261114'.
