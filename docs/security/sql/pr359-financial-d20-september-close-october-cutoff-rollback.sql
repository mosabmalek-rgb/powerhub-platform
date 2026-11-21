-- D20 installed Staging: completed September C4 close, October cutoff fail closed.
-- The source is tested as installed; no DDL. No Production. No certification.
-- Everything inserted by test identities 4/260 rolls back.
-- The synthetic evidence is format-only, NOT independent human attestation.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='120000ms';
DO $d20$
DECLARE evid jsonb;oct_id bigint;sep_id bigint;sep_result jsonb;
 sep_status jsonb;oct_source jsonb;denied boolean:=false;
BEGIN
 IF (SELECT count(*) FROM public.financial_accrual_period_reviews)<>0
 OR (SELECT count(*) FROM public.financial_gl_entries)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines)<>51
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 THEN RAISE EXCEPTION 'D20_STAGING_BASELINE_CHANGED';END IF;
 IF to_char(clock_timestamp() AT TIME ZONE 'Asia/Gaza','YYYY-MM')<>'2026-11'
 THEN RAISE EXCEPTION 'D20_EXPECTED_NOVEMBER_STAGING_ONLY';END IF;
 evid:=jsonb_build_object(
 'unbilled_service','D20 temporary synthetic evidence only',
 'invoice_cutoff','D20 temporary synthetic evidence only',
 'supplier_reconciliation','D20 temporary synthetic evidence only',
 'inventory_reconciliation','D20 temporary synthetic evidence only',
 'payroll_reconciliation','D20 temporary synthetic evidence only',
 'depreciation_register','D20 temporary synthetic evidence only',
 'provision_assessment','D20 temporary synthetic evidence only',
 'tax_reconciliation','D20 temporary synthetic evidence only');
 oct_source:=public.powerhub_financial_accrual_month_statement(1,1,'2026-10',now());
 IF (oct_source->>'issuedOutsideServiceMonthCount')::integer<>1
 OR (SELECT count(*) FROM public.invoices
 WHERE id=31 AND tenant_id=1 AND site_id=1
 AND (cycle_end_at AT TIME ZONE 'Asia/Gaza')::date=DATE '2026-10-31'
 AND (issue_date AT TIME ZONE 'Asia/Gaza')::date=DATE '2026-11-01')<>1
 THEN RAISE EXCEPTION 'D20_OCTOBER_INVOICE_FIXTURE_DRIFT';END IF;
 oct_id:=public.powerhub_financial_accrual_period_save_review(1,1,'2026-10',4,evid);
 BEGIN
 PERFORM public.powerhub_financial_accrual_period_lock(1,1,'2026-10',260);
 EXCEPTION WHEN SQLSTATE '22023' THEN
 denied:=SQLERRM='ACCRUAL_CLOSE_UNRESOLVED_SOURCE_issuedOutsideServiceMonthCount';
 END;
 IF NOT denied THEN RAISE EXCEPTION 'D20_OCTOBER_CUTOFF_NOT_BLOCKED';END IF;
 IF (SELECT status FROM public.financial_accrual_period_reviews WHERE id=oct_id)
 IS DISTINCT FROM 'draft'
 OR EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews WHERE id=oct_id
 AND (source_fingerprint IS NOT NULL OR locked_at IS NOT NULL))
 THEN RAISE EXCEPTION 'D20_OCTOBER_BLOCKED_BUT_STATE_MUTATED';END IF;
 sep_id:=public.powerhub_financial_accrual_period_save_review(1,1,'2026-09',4,evid);
 sep_result:=public.powerhub_financial_accrual_period_lock(1,1,'2026-09',260);
 sep_status:=public.powerhub_financial_accrual_period_review_status(1,1,'2026-09');
 IF sep_result->>'status' IS DISTINCT FROM 'locked'
 OR sep_result->>'alreadyLocked' IS DISTINCT FROM 'false'
 OR sep_result->>'isCertifiedProfit' IS DISTINCT FROM 'false'
 OR sep_status->>'status' IS DISTINCT FROM 'locked'
 OR sep_status->>'driftDetected' IS DISTINCT FROM 'false'
 OR sep_status->>'fingerprintVersion' IS DISTINCT FROM 'financial_v3'
 OR sep_status->>'isCertifiedProfit' IS DISTINCT FROM 'false'
 THEN RAISE EXCEPTION 'D20_SEPTEMBER_COMPLETED_CLOSE_OR_V3_FINGERPRINT_INVALID';END IF;
 IF (SELECT count(*) FROM public.financial_accrual_period_reviews WHERE status='draft')<>1
 OR (SELECT count(*) FROM public.financial_accrual_period_reviews WHERE status='locked')<>1
 THEN RAISE EXCEPTION 'D20_PERIOD_STATUS_CROSS_CONTAMINATION';END IF;
END $d20$;
SELECT 'D20_OCTOBER_CUTOFF_BLOCKED_SEPTEMBER_COMPLETED_V3_LOCK_PASS' AS result;
ROLLBACK;

DO $after$
BEGIN
 IF (SELECT count(*) FROM public.financial_accrual_period_reviews)<>0
 OR (SELECT count(*) FROM public.financial_gl_entries)<>25
 OR (SELECT count(*) FROM public.financial_gl_lines)<>51
 OR (SELECT count(*) FROM public.account_transactions)<>361009
 THEN RAISE EXCEPTION 'D20_FINANCIAL_ROLLBACK_INCOMPLETE';END IF;
END $after$;
SELECT 'D20_POST_ROLLBACK_BASELINE_UNCHANGED_PASS' AS result;
