-- A40: cash movement chronology / source-link regression. Staging test ONLY.
-- No durable payment, journal, or human attestation is created.
BEGIN;
SET LOCAL statement_timeout='40000ms';
DO $a40$
DECLARE v_tx bigint; v_lines jsonb;
BEGIN
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)<>0
 OR (SELECT count(*) FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1)<>0
 OR (SELECT count(*) FROM public.payroll_adjustment_allocations WHERE payroll_run_id=1)<>0
 OR NOT EXISTS(SELECT 1 FROM public.employee_adjustments WHERE id=1 AND tenant_id=1
    AND site_id=1 AND disbursed_at IS NULL AND disbursement_transaction_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM public.payroll_runs WHERE id=1 AND tenant_id=1 AND site_id=1
    AND total_net=5525 AND total_deductions=25 AND status='approved')
 THEN RAISE EXCEPTION 'A40_STAGING_PRECONDITIONS_CHANGED'; END IF;
 INSERT INTO public.account_transactions
 (tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id,occurred_at)
 VALUES(1,1,5,'withdrawal',300,'A40 rollback-only synthetic cash movement',
 'EMP-ADV:A40-ROLLBACK-ONLY',4,'2026-11-05T10:00:00Z') RETURNING id INTO v_tx;
 UPDATE public.employee_adjustments
 SET disbursed_at='2026-09-29T10:00:00Z',
 disbursement_account_id=5,disbursement_transaction_id=v_tx WHERE id=1;
 INSERT INTO public.payroll_adjustment_allocations(payroll_run_id,adjustment_id,amount) VALUES(1,1,100);
 UPDATE public.payroll_items SET advance_deduction=100,net_amount=1800 WHERE id=1 AND payroll_run_id=1;
 UPDATE public.payroll_runs SET total_net=5425,total_deductions=125
 WHERE id=1 AND tenant_id=1 AND site_id=1;
 IF public.powerhub_payroll_advance_allocations_valid(1,1,1,'2026-10') IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A40_LATE_CASH_POSTING_BACKDATED_AS_ADVANCE_ACCEPTED'; END IF;
 UPDATE public.employee_adjustments SET disbursed_at='2026-11-05T10:00:00Z' WHERE id=1;
 IF public.powerhub_payroll_advance_allocations_valid(1,1,1,'2026-10') IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'A40_FUTURE_DISBURSEMENT_ACCEPTED'; END IF;
 UPDATE public.account_transactions SET occurred_at='2026-09-29T10:00:00Z' WHERE id=v_tx;
 UPDATE public.employee_adjustments SET disbursed_at='2026-09-29T10:00:00Z' WHERE id=1;
 IF public.powerhub_payroll_advance_allocations_valid(1,1,1,'2026-10') IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'A40_VALID_CASH_DISBURSEMENT_REJECTED'; END IF;
 v_lines:=public.powerhub_financial_gl_source_plan(1,1,'payroll',1)->'lines';
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_lines) x
  WHERE x->>'code'='1700' AND x->>'side'='credit' AND (x->>'amount')::numeric=100)
 THEN RAISE EXCEPTION 'A40_CORRECT_PAYROLL_GL_ENTRY_MISSING'; END IF;
END;
$a40$;
SELECT 'PASS_ROLLBACK_ONLY' AS status,
 false AS accepted_backdated_late_disbursement,
 true AS accepted_matching_prior_disbursement;
ROLLBACK;
