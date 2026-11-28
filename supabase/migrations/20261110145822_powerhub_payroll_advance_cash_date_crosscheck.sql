-- A40, applied to Staging as 20261110145822.
-- Prevent the advance's stored date from disguising a later cash withdrawal.
-- Any future deployment keeps the same guard; existing function ACL is preserved.
CREATE OR REPLACE FUNCTION public.powerhub_payroll_advance_allocations_valid(p_tenant_id bigint, p_site_id bigint, p_payroll_run_id bigint, p_period text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT p_tenant_id>0 AND p_site_id>0 AND p_payroll_run_id>0
 AND p_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 AND EXISTS (SELECT 1 FROM public.payroll_runs r
   WHERE r.id=p_payroll_run_id AND r.tenant_id=p_tenant_id AND r.site_id=p_site_id
     AND r.period=p_period)
 AND NOT EXISTS (
  SELECT 1 FROM public.payroll_items pi
  LEFT JOIN LATERAL(
    SELECT coalesce(sum(pa.amount),0) amt,
      coalesce(bool_and(
        adj.id IS NOT NULL
        AND adj.tenant_id=p_tenant_id AND adj.site_id=p_site_id
        AND adj.employee_id=pi.employee_id AND adj.adjustment_type='advance'
        AND adj.disbursed_at IS NOT NULL
        AND adj.disbursement_transaction_id IS NOT NULL
        AND (adj.disbursed_at AT TIME ZONE 'Asia/Gaza')::date
          < ((p_period||'-01')::date+interval '1 month')::date
        AND tx.id IS NOT NULL AND tx.tenant_id=p_tenant_id AND tx.site_id=p_site_id
        AND tx.account_id=adj.disbursement_account_id
        AND tx.transaction_type='withdrawal' AND tx.amount=adj.amount
        AND tx.reference_no LIKE 'EMP-ADV:%'
        -- Actual settlement date must equal the advance date and precede payroll cutoff.
        AND (tx.occurred_at AT TIME ZONE 'Asia/Gaza')::date
          = (adj.disbursed_at AT TIME ZONE 'Asia/Gaza')::date
        AND (tx.occurred_at AT TIME ZONE 'Asia/Gaza')::date
          < ((p_period||'-01')::date + interval '1 month')::date
        AND tx.related_payment_id IS NULL
        AND tx.related_expense_id IS NULL
        AND tx.related_supplier_payment_id IS NULL
        AND tx.related_supplier_return_id IS NULL
        AND tx.related_account_id IS NULL
      ),true) verified
    FROM public.payroll_adjustment_allocations pa
    LEFT JOIN public.employee_adjustments adj ON adj.id=pa.adjustment_id
    LEFT JOIN public.account_transactions tx ON tx.id=adj.disbursement_transaction_id
    WHERE pa.payroll_run_id=pi.payroll_run_id
      AND (adj.employee_id=pi.employee_id OR adj.id IS NULL)
  ) a ON TRUE
  WHERE pi.payroll_run_id=p_payroll_run_id
    AND (pi.advance_deduction IS NULL OR pi.advance_deduction<0
      OR pi.advance_deduction<>a.amt OR NOT a.verified)
 )
 AND NOT EXISTS (
   SELECT 1 FROM public.payroll_adjustment_allocations pa
   LEFT JOIN public.employee_adjustments adj ON adj.id=pa.adjustment_id
   LEFT JOIN public.payroll_items pi ON pi.payroll_run_id=pa.payroll_run_id
     AND pi.employee_id=adj.employee_id
   WHERE pa.payroll_run_id=p_payroll_run_id AND pi.id IS NULL
 );
$function$
;
REVOKE ALL ON FUNCTION public.powerhub_payroll_advance_allocations_valid(bigint,bigint,bigint,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_payroll_advance_allocations_valid(bigint,bigint,bigint,text)
 TO service_role;
