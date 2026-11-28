-- A38: positive advance-disbursement control. Insert/modify test data only
-- inside a rollback transaction. This is not a real payment or financial approval.
BEGIN;
SET LOCAL statement_timeout='35000ms';
DO $qa$
DECLARE v_tx bigint;v_lines jsonb;
BEGIN
 IF public.powerhub_payroll_advance_allocations_valid(1,1,1,'2026-10') IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM public.employee_adjustments
   WHERE id=1 AND tenant_id=1 AND site_id=1
   AND disbursed_at IS NULL AND disbursement_transaction_id IS NULL)
 THEN RAISE EXCEPTION 'A38_POSITIVE_PRECONDITION_FAILED'; END IF;
 INSERT INTO public.account_transactions
 (tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,
 created_by_user_id,occurred_at)
 VALUES(1,1,5,'withdrawal',300,'Synthetic advance disbursement rollback-only QA',
 'EMP-ADV:QA-A38-ROLLBACK',4,'2026-09-29T10:00:00Z')
 RETURNING id INTO v_tx;
 UPDATE public.employee_adjustments
 SET disbursed_at='2026-09-29T10:00:00Z',
 disbursement_transaction_id=v_tx,disbursement_account_id=5 WHERE id=1;
 INSERT INTO public.payroll_adjustment_allocations(payroll_run_id,adjustment_id,amount)
 VALUES(1,1,100);
 UPDATE public.payroll_items SET advance_deduction=100,net_amount=1800
 WHERE id=1 AND payroll_run_id=1;
 UPDATE public.payroll_runs SET total_net=5425,total_deductions=125
 WHERE id=1 AND tenant_id=1 AND site_id=1;
 IF public.powerhub_payroll_advance_allocations_valid(1,1,1,'2026-10') IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'A38_VALID_DISBURSEMENT_FALSELY_REJECTED'; END IF;
 v_lines:=public.powerhub_financial_gl_source_plan(1,1,'payroll',1)->'lines';
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_lines) l
   WHERE l->>'code'='1700' AND l->>'side'='credit'
     AND (l->>'amount')::numeric=100)
 THEN RAISE EXCEPTION 'A38_ADVANCE_GL_CREDIT_NOT_PRESENT'; END IF;
END;
$qa$;
SELECT 'PASS_ROLLBACK_ONLY' AS positive_disbursement_case;
ROLLBACK;
