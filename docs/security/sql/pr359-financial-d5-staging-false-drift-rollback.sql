-- PR #359 Phase D5 — REPRODUCER FOR AN EXISTING BUG, NOT A PASSING REGRESSION.
-- Staging-only (tenant_id=1, site_id=1), technical smoke within BEGIN/ROLLBACK.
-- NO accounting certification: attestation values are explicitly temporary test labels.
-- This file intentionally proves that cash-only changes and harmless payroll metadata
-- currently cause a locked accrual snapshot to report false source drift.
-- A future fix must replace this expected-bug assertion with a NEGATIVE regression
-- (both should have driftDetected=false), while retaining positive financial drift tests.
-- Never run against Production. Required staging fixture: payroll_runs.id=1,
-- site_id=1, tenant_id=1, period='2026-10'; company_accounts.id=5;
-- users.id IN (2,3); no persisted September 2026 accrual review.
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='2s';

CREATE TEMP TABLE d5_repro_results(
  case_name text PRIMARY KEY,
  statement_unchanged boolean NOT NULL,
  detail_fingerprint_changed boolean NOT NULL,
  drift_detected boolean NOT NULL
) ON COMMIT DROP;

DO $repro$
DECLARE
 v_evidence jsonb:='{}'::jsonb;
 v_key text;
 v_snapshot_before jsonb;
 v_snapshot_after jsonb;
 v_fp_before text;
 v_fp_after text;
 v_status jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews
   WHERE tenant_id=1 AND site_id=1 AND period='2026-09') THEN
  RAISE EXCEPTION 'D5_REPRO_NOT_SAFE_EXISTING_SEPTEMBER_REVIEW';
 END IF;
 UPDATE public.payroll_runs SET period='2026-09'
 WHERE id=1 AND tenant_id=1 AND site_id=1 AND period='2026-10';
 IF NOT FOUND THEN RAISE EXCEPTION 'D5_REPRO_MISSING_PAYROLL_FIXTURE'; END IF;
 FOREACH v_key IN ARRAY ARRAY[
   'unbilled_service','invoice_cutoff','supplier_reconciliation',
   'inventory_reconciliation','payroll_reconciliation','depreciation_register',
   'provision_assessment','tax_reconciliation'
 ] LOOP
  v_evidence:=v_evidence||jsonb_build_object(v_key,
    'D5 TECHNICAL ROLLBACK ONLY - NOT ACCOUNTING EVIDENCE');
 END LOOP;
 PERFORM public.powerhub_financial_accrual_period_save_review(
   1,1,'2026-09',2,v_evidence);
 IF (public.powerhub_financial_accrual_period_lock(
   1,1,'2026-09',3)->>'status') IS DISTINCT FROM 'locked' THEN
   RAISE EXCEPTION 'D5_REPRO_CANNOT_LOCK';
 END IF;

 -- Case 1: modify permitted payroll metadata on a closed month.
 v_fp_before:=public.powerhub_financial_accrual_detail_fingerprint(1,1,'2026-09');
 v_snapshot_before:=public.powerhub_financial_accrual_month_statement(1,1,'2026-09',now())-'asOf';
 UPDATE public.payroll_runs SET updated_at=updated_at+interval '1 second'
 WHERE id=1 AND period='2026-09';
 v_fp_after:=public.powerhub_financial_accrual_detail_fingerprint(1,1,'2026-09');
 v_snapshot_after:=public.powerhub_financial_accrual_month_statement(1,1,'2026-09',now())-'asOf';
 v_status:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-09');
 INSERT INTO pg_temp.d5_repro_results VALUES(
 'permitted payroll metadata',v_snapshot_before=v_snapshot_after,
 v_fp_before<>v_fp_after,(v_status->>'driftDetected')::boolean);

 -- Case 2: unrelated cash deposit in the previously closed accrual month.
 -- No financial_settlements period is locked in this fixture.
 v_fp_before:=v_fp_after;
 v_snapshot_before:=v_snapshot_after;
 INSERT INTO public.account_transactions(
  tenant_id,site_id,account_id,transaction_type,amount,description,
  reference_no,occurred_at,created_by_user_id)
 VALUES(1,1,5,'deposit',0.01,'D5 non-accrual test only',
 'D5-ROLLBACK-FP-CASH-20261114','2026-09-15 12:00+03',2);
 v_fp_after:=public.powerhub_financial_accrual_detail_fingerprint(1,1,'2026-09');
 v_snapshot_after:=public.powerhub_financial_accrual_month_statement(1,1,'2026-09',now())-'asOf';
 v_status:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-09');
 INSERT INTO pg_temp.d5_repro_results VALUES(
 'unrelated cash deposit',v_snapshot_before=v_snapshot_after,
 v_fp_before<>v_fp_after,(v_status->>'driftDetected')::boolean);

 IF EXISTS(SELECT 1 FROM pg_temp.d5_repro_results
  WHERE NOT statement_unchanged OR NOT detail_fingerprint_changed OR NOT drift_detected)
 THEN RAISE EXCEPTION 'D5_EXISTING_BUG_NOT_REPRODUCED';END IF;
END $repro$;

SELECT * FROM pg_temp.d5_repro_results ORDER BY case_name;
-- Explicitly discard the temporary close, synthetic source writes and all logs.
ROLLBACK;

-- After running, independently verify:
-- SELECT count(*) FROM public.financial_accrual_period_reviews
--    WHERE tenant_id=1 AND site_id=1 AND period='2026-09'; -- must be 0
-- SELECT count(*) FROM public.account_transactions
--    WHERE reference_no='D5-ROLLBACK-FP-CASH-20261114'; -- must be 0
-- SELECT period FROM public.payroll_runs WHERE id=1; -- must be '2026-10'
