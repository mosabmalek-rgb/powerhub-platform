-- A38 regression: an unpaid/undisbursed employee advance can never
-- justify payroll deduction, approval, or GL posting. This only simulates
-- the defect inside a transaction and always rolls back.
BEGIN;
SET LOCAL statement_timeout='25000ms';
DO $guard$
BEGIN
 IF (SELECT count(*) FROM public.financial_gl_entries WHERE tenant_id=1 AND site_id=1)<>0
 OR (SELECT count(*) FROM public.financial_gl_opening_batches WHERE tenant_id=1 AND site_id=1)<>0
 OR NOT EXISTS(SELECT 1 FROM public.payroll_runs r WHERE r.id=1
   AND r.tenant_id=1 AND r.site_id=1 AND r.period='2026-10'
   AND r.status='approved' AND r.total_gross=5550
   AND r.total_net=5525 AND r.total_deductions=25)
 OR NOT EXISTS(SELECT 1 FROM public.employee_adjustments
   WHERE id=1 AND tenant_id=1 AND site_id=1
   AND disbursed_at IS NULL AND disbursement_transaction_id IS NULL)
 THEN RAISE EXCEPTION 'A38_STAGING_FIXTURE_PRECONDITION_FAILED'; END IF;
END;
$guard$;
INSERT INTO public.payroll_adjustment_allocations(payroll_run_id,adjustment_id,amount)
VALUES(1,1,100);
UPDATE public.payroll_items SET advance_deduction=100,net_amount=1800
WHERE id=1 AND payroll_run_id=1;
UPDATE public.payroll_runs SET status='draft',approved_by_user_id=NULL,
 total_net=5425,total_deductions=125 WHERE id=1 AND tenant_id=1 AND site_id=1;
DO $qa$
DECLARE msg text;
BEGIN
 IF public.powerhub_payroll_advance_allocations_valid(1,1,1,'2026-10') IS DISTINCT FROM FALSE
 THEN RAISE EXCEPTION 'A38_INVALID_ADVANCE_NOT_DETECTED'; END IF;
 BEGIN
  PERFORM public.powerhub_approve_payroll(1,1,4,1);
  RAISE EXCEPTION 'A38_APPROVAL_WRONGLY_ALLOWED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID'
  THEN RAISE EXCEPTION 'A38_APPROVAL_BAD_ERROR_%',msg; END IF;
 END;
 UPDATE public.payroll_runs SET status='approved',approved_by_user_id=4
 WHERE id=1;
 BEGIN
  PERFORM public.powerhub_financial_gl_source_plan(1,1,'payroll',1);
  RAISE EXCEPTION 'A38_GL_WRONGLY_ALLOWED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg<>'GL_PAYROLL_ADVANCE_DISBURSEMENT_OR_ALLOCATION_INVALID'
  THEN RAISE EXCEPTION 'A38_GL_BAD_ERROR_%',msg; END IF;
 END;
END;
$qa$;
SELECT 'PASS_ROLLBACK_ONLY' AS status,
 false AS fictitious_advance_accepted;
ROLLBACK;
