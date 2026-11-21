-- D19: installed Supabase Staging C4 premature close + maker/checker guard.
-- Run ONLY against the known tenant 1/site 1 2026-11 disposable fixture
-- on 15–29 November 2026, inside BEGIN/ROLLBACK; never Production.
-- Evidence below is deliberately SYNTHETIC AND NOT HUMAN-APPROVED.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='60000ms';
DO $d19$
DECLARE
  evid jsonb;review_id bigint;rejected boolean:=false;
  status_before jsonb;status_draft jsonb;
BEGIN
 IF (SELECT count(*) FROM public.financial_accrual_period_reviews)<>0
 OR (SELECT count(*) FROM public.financial_gl_entries)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines)<>51
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 THEN RAISE EXCEPTION 'D19_STAGING_BASELINE_CHANGED'; END IF;
 IF to_char(clock_timestamp() AT TIME ZONE 'Asia/Gaza','YYYY-MM')<>'2026-11'
 THEN RAISE EXCEPTION 'D19_MONTH_CHANGED_USE_NEW_ACCEPTANCE_FIXTURE';END IF;
 IF (clock_timestamp() AT TIME ZONE 'Asia/Gaza')::date>=DATE '2026-11-30'
 THEN RAISE EXCEPTION 'D19_TEST_NOT_VALID_ON_LAST_DAY_OF_MONTH'; END IF;
 status_before:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-11');
 IF status_before->>'status' IS DISTINCT FROM 'unprepared'
 THEN RAISE EXCEPTION 'D19_REVIEW_ALREADY_EXISTS'; END IF;
 evid:=jsonb_build_object(
  'unbilled_service','D19 rollback test only',
  'invoice_cutoff','D19 rollback test only',
  'supplier_reconciliation','D19 rollback test only',
  'inventory_reconciliation','D19 rollback test only',
  'payroll_reconciliation','D19 rollback test only',
  'depreciation_register','D19 rollback test only',
  'provision_assessment','D19 rollback test only',
  'tax_reconciliation','D19 rollback test only');
 IF public.powerhub_financial_accrual_review_evidence_valid(evid) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'D19_EVIDENCE_TEST_SHAPE_INVALID';END IF;
 review_id:=public.powerhub_financial_accrual_period_save_review(1,1,'2026-11',4,evid);
 status_draft:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-11');
 IF review_id IS NULL OR status_draft->>'status' IS DISTINCT FROM 'draft'
 OR status_draft->>'isCertifiedProfit' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'D19_DRAFT_NOT_SAVED';END IF;
 BEGIN
  PERFORM public.powerhub_financial_accrual_period_lock(1,1,'2026-11',4);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  rejected:=(SQLERRM='ACCRUAL_SEPARATION_OF_DUTIES');
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'D19_SELF_CLOSE_FALSELY_ACCEPTED';END IF;
 rejected:=false;
 BEGIN
  PERFORM public.powerhub_financial_accrual_period_lock(1,1,'2026-11',260);
 EXCEPTION WHEN SQLSTATE '22023' THEN
  rejected:=(SQLERRM='ACCRUAL_PERIOD_NOT_FINISHED');
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'D19_PREMATURE_MONTH_CLOSE_FALSELY_ACCEPTED';END IF;
 IF (SELECT status FROM public.financial_accrual_period_reviews
    WHERE id=review_id) IS DISTINCT FROM 'draft'
 OR EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews
    WHERE id=review_id AND
      (locked_by_user_id IS NOT NULL OR source_fingerprint IS NOT NULL
       OR locked_snapshot IS NOT NULL))
 THEN RAISE EXCEPTION 'D19_DENIED_CLOSE_STILL_MODIFIED_REVIEW';END IF;
 IF has_function_privilege('anon',
    'public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)','EXECUTE')
 OR has_function_privilege('authenticated',
    'public.powerhub_financial_accrual_period_lock(bigint,bigint,text,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'D19_UNPRIVILEGED_BROWSER_CLOSE_RPC_EXECUTE';END IF;
END $d19$;
SELECT 'D19_STAGING_PREMATURE_CLOSE_AND_SELF_APPROVAL_FAIL_CLOSED_ROLLBACK_PASS' AS result;
ROLLBACK;

DO $after$
BEGIN
 IF (SELECT count(*) FROM public.financial_accrual_period_reviews)<>0
 OR (SELECT count(*) FROM public.financial_gl_entries)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines)<>51
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 THEN RAISE EXCEPTION 'D19_ROLLBACK_LEFT_FINANCIAL_SIDE_EFFECTS';END IF;
END $after$;
SELECT 'D19_STAGING_POST_ROLLBACK_FINANCIAL_BASELINE_PASS' AS result;
