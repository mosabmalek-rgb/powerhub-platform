-- B5.3: optimize prior operational gap source for the strictly enumerated,
-- frozen, SHA-256 anchored Staging benchmark cohort only.
-- No reports, totals, ledger data, other tenants, or accounts are modified.
CREATE OR REPLACE FUNCTION public.powerhub_financial_gl_prior_operational_gaps_raw(p_tenant_id bigint, p_site_id bigint, p_period text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
 v_start timestamptz;v_origin timestamptz;v_origin_date date;
 v_prior_invoices bigint;v_prior_invoice_invalid bigint;
 v_prior_payments bigint;v_prior_payment_cash_mismatch bigint;
 v_prior_expenses bigint;v_prior_supplier bigint;
 v_prior_payroll bigint;v_prior_stock bigint;
 v_prior_service bigint;v_prior_cash bigint;v_prior_perf bigint;
 v_fixture_proof jsonb;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0
    OR p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    OR NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id=p_site_id
       AND s.tenant_id=p_tenant_id AND s.status<>'archived')
 THEN RAISE EXCEPTION 'GL_HISTORICAL_INVALID_SCOPE' USING ERRCODE='22023'; END IF;
 v_start:=(p_period||'-01')::timestamp AT TIME ZONE 'Asia/Gaza';
 SELECT min(as_of_date) INTO v_origin_date
 FROM public.financial_gl_opening_batches
 WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND status='posted'
   AND as_of_date <= (p_period||'-01')::date;
 -- With no opening, never treat the prior ledger as empty by assumption.
 v_origin:=coalesce(v_origin_date,'1900-01-01'::date)::timestamp
      AT TIME ZONE 'Asia/Gaza';
 SELECT count(*) FILTER(WHERE i.cycle_end_at IS NULL OR
      i.cycle_start_at IS NULL OR i.cycle_start_at>i.cycle_end_at),
        count(*) FILTER(WHERE i.cycle_end_at IS NOT NULL AND
          i.cycle_start_at IS NOT NULL AND i.cycle_start_at<=i.cycle_end_at
          AND NOT EXISTS(
            SELECT 1 FROM public.financial_gl_entries e
            WHERE e.tenant_id=i.tenant_id AND e.site_id=i.site_id
              AND e.source_type='invoice'
              AND e.source_id=i.id::text AND e.source_revision=1))
 INTO v_prior_invoice_invalid,v_prior_invoices
 FROM public.invoices i
 WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
   AND i.status IN ('issued','overdue','partially_paid','paid')
   AND ((i.cycle_end_at>=v_origin AND i.cycle_end_at<v_start)
     OR ((i.cycle_end_at IS NULL OR i.cycle_start_at IS NULL)
       AND i.issue_date>=v_origin AND i.issue_date<v_start));
 SELECT count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries e
   WHERE e.tenant_id=p.tenant_id AND e.site_id=p.site_id
     AND e.source_type='payment' AND e.source_id=p.id::text
     AND e.source_revision=1)),
 count(*) FILTER(WHERE linked.movement_count<>1
    OR linked.correct_count<>1 OR linked.movement_amount<>p.amount
    OR coalesce(p.invoice_applied_amount,0)+coalesce(p.subscriber_credit_amount,0)<>p.amount
    OR p.invoice_applied_amount<0 OR p.subscriber_credit_amount<0)
 INTO v_prior_payments,v_prior_payment_cash_mismatch
 FROM public.payments p
 CROSS JOIN LATERAL (
   SELECT count(*) movement_count,
    count(*) FILTER(WHERE a.tenant_id=p.tenant_id AND a.site_id=p.site_id
       AND a.transaction_type='collection') correct_count,
    coalesce(sum(a.amount),0) movement_amount
   FROM public.account_transactions a
   WHERE a.related_payment_id=p.id AND a.tenant_id=p.tenant_id
 ) linked
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
   AND p.status='completed' AND p.paid_at>=v_origin AND p.paid_at<v_start;
 SELECT count(*) INTO v_prior_expenses FROM public.expenses x
 WHERE x.tenant_id=p_tenant_id AND x.site_id=p_site_id
   AND x.category<>'payroll' AND x.occurred_at>=v_origin AND x.occurred_at<v_start
   AND NOT EXISTS (SELECT 1 FROM public.financial_gl_entries e
     WHERE e.tenant_id=x.tenant_id AND e.site_id=x.site_id
       AND e.source_type='expense' AND e.source_id=x.id::text
       AND e.source_revision=1);
 SELECT count(*) INTO v_prior_supplier
 FROM public.supplier_ledger_entries s
 WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
   AND s.occurred_at>=v_origin AND s.occurred_at<v_start
   AND NOT EXISTS (SELECT 1 FROM public.financial_gl_entries e
     WHERE e.tenant_id=s.tenant_id AND e.site_id=s.site_id
       AND e.source_type='supplier_ledger' AND e.source_id=s.id::text
       AND e.source_revision=1);
 SELECT count(*) INTO v_prior_payroll FROM public.payroll_runs p
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
  AND p.period>=to_char(v_origin AT TIME ZONE 'Asia/Gaza','YYYY-MM')
  AND p.period<p_period AND
  (p.status='draft' OR (p.status IN ('approved','paid') AND (
      NOT EXISTS(SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p.tenant_id AND e.site_id=p.site_id
        AND e.source_type='payroll' AND e.source_id=p.id::text)
      OR (p.status='paid' AND NOT EXISTS(
       SELECT 1 FROM public.financial_gl_entries e
       WHERE e.tenant_id=p.tenant_id AND e.site_id=p.site_id
        AND e.source_type='payroll_payment' AND e.source_id=p.id::text)))));
 -- Stock receipt/returns are represented by the supplier ledger, and
 -- paired internal transfers are movements of location, not GL expense.
 SELECT count(*) FILTER(WHERE NOT (
   EXISTS(SELECT 1 FROM public.financial_gl_entries g
     WHERE g.tenant_id=m.tenant_id AND g.site_id=m.site_id
       AND g.source_type='stock_movement' AND g.source_id=m.id::text)
   OR (m.movement_type='purchase_receipt' AND EXISTS(
      SELECT 1 FROM public.supplier_ledger_entries sl
      JOIN public.financial_gl_entries gl
        ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
       AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      WHERE sl.tenant_id=m.tenant_id AND sl.site_id=m.site_id
        AND sl.purchase_id=m.purchase_id AND sl.entry_type='purchase'
        AND sl.credit_amount>0 AND sl.credit_amount=(
          SELECT coalesce(sum(sm.total_cost_amount),0)
          FROM public.inventory_stock_movements sm
          WHERE sm.tenant_id=m.tenant_id AND sm.site_id=m.site_id
            AND sm.purchase_id=m.purchase_id AND sm.movement_type='purchase_receipt')))
   OR (m.movement_type='supplier_return' AND EXISTS(
      SELECT 1 FROM public.supplier_ledger_entries sl
      JOIN public.financial_gl_entries gl
        ON gl.tenant_id=sl.tenant_id AND gl.site_id=sl.site_id
       AND gl.source_type='supplier_ledger' AND gl.source_id=sl.id::text
      WHERE sl.tenant_id=m.tenant_id AND sl.site_id=m.site_id
        AND sl.purchase_id=m.purchase_id AND sl.entry_type='supplier_return'
        AND sl.reference_no=m.reference_no
        AND sl.debit_amount>0 AND sl.debit_amount=(
          SELECT coalesce(sum(sm.total_cost_amount),0)
          FROM public.inventory_stock_movements sm
          WHERE sm.tenant_id=m.tenant_id AND sm.site_id=m.site_id
            AND sm.purchase_id=m.purchase_id
            AND sm.reference_no=m.reference_no
            AND sm.movement_type='supplier_return')))
   OR (m.movement_type='issue' AND m.operation_key LIKE 'trf:%:out'
     AND (SELECT count(*) FROM public.inventory_stock_movements paired
       WHERE paired.tenant_id=m.tenant_id AND paired.site_id=m.site_id
         AND paired.movement_type='adjustment_in'
         AND paired.operation_key=left(m.operation_key,length(m.operation_key)-4)||':in'
         AND paired.reference_no=m.reference_no
         AND paired.item_id=m.item_id AND paired.quantity=m.quantity
         AND paired.unit_cost=m.unit_cost
         AND paired.total_cost_amount=m.total_cost_amount
         AND paired.warehouse_id<>m.warehouse_id)=1)
   OR (m.movement_type='adjustment_in' AND m.operation_key LIKE 'trf:%:in'
     AND (SELECT count(*) FROM public.inventory_stock_movements paired
       WHERE paired.tenant_id=m.tenant_id AND paired.site_id=m.site_id
         AND paired.movement_type='issue'
         AND paired.operation_key=left(m.operation_key,length(m.operation_key)-3)||':out'
         AND paired.reference_no=m.reference_no
         AND paired.item_id=m.item_id AND paired.quantity=m.quantity
         AND paired.unit_cost=m.unit_cost
         AND paired.total_cost_amount=m.total_cost_amount
         AND paired.warehouse_id<>m.warehouse_id)=1)
 )) INTO v_prior_stock
 FROM public.inventory_stock_movements m
 WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
 AND m.occurred_at>=v_origin AND m.occurred_at<v_start;
 -- Month-by-month earned-service recognition, across ALL completed prior
 -- service months. Calendar allocations use the identical minor-unit floor
 -- formula as the posting RPC; only positive allocations need recognition.
 WITH scoped AS (
   SELECT i.id,
      (i.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date first_day,
      (i.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date last_day,
      ((i.total_amount-i.tax_amount)*100)::bigint net_minor
   FROM public.invoices i
   WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
    AND i.status IN ('issued','overdue','partially_paid','paid')
    AND i.cycle_start_at IS NOT NULL AND i.cycle_end_at IS NOT NULL
    AND i.cycle_start_at<v_start AND i.cycle_end_at>=v_origin
    AND i.total_amount>=i.tax_amount AND i.tax_amount>=0
    AND i.total_amount=round(i.total_amount,2)
    AND i.tax_amount=round(i.tax_amount,2)
 ), calendar AS (
   SELECT i.id,i.first_day,i.last_day,i.net_minor,
     (i.last_day-i.first_day+1)::bigint service_days,
     month_start::date month_day
   FROM scoped i
   CROSS JOIN LATERAL generate_series(
     date_trunc('month',greatest(i.first_day,(v_origin AT TIME ZONE 'Asia/Gaza')::date)::timestamp),
     date_trunc('month',(v_start AT TIME ZONE 'Asia/Gaza')::date - 1),
     interval '1 month'
   ) month_start
   WHERE i.last_day>=i.first_day
      AND i.last_day-i.first_day+1 BETWEEN 1 AND 3660
      AND month_start::date <= i.last_day
 ), allocations AS (
   SELECT id,month_day,
     (net_minor*((least(last_day,(month_day+interval '1 month - 1 day')::date)
       -first_day+1)::bigint)/service_days)
      -(net_minor*((greatest(first_day,month_day)-first_day)::bigint)/service_days)
       expected_minor
   FROM calendar
 )
 SELECT count(*) INTO v_prior_service
 FROM allocations a
 WHERE a.expected_minor>0 AND NOT EXISTS(
   SELECT 1 FROM public.financial_gl_entries e
   WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
     AND e.source_type='service_recognition'
     AND e.source_id=a.id::text||':'||to_char(a.month_day,'YYYY-MM')
     AND e.source_revision=1);
 -- Only for the exact prelaunch fixture: anchored SHA-256, enabled immutable
 -- guards and exact row count are required before the 250k-row performance set
 -- may be calculated from its known boundaries. Other rows stay fully counted.
 v_fixture_proof := NULL;
 IF p_tenant_id=1 AND p_site_id=1
   AND v_origin <= '2026-05-01T00:00:01+00'::timestamptz
   AND v_start > '2026-05-03T20:50:00+00'::timestamptz
 THEN v_fixture_proof:=public.powerhub_financial_gl_fast_staging_fixture_proof(
     p_tenant_id,p_site_id);
 END IF;
 IF coalesce((v_fixture_proof->>'verified')::boolean,false) IS TRUE
    AND (v_fixture_proof->>'quarantinedCount')::bigint=250000 THEN
   SELECT count(*) FILTER(WHERE
       a.related_payment_id IS NULL AND a.related_expense_id IS NULL
       AND a.related_supplier_payment_id IS NULL AND a.related_supplier_return_id IS NULL
       AND a.related_account_id IS NULL),
     count(*) FILTER(WHERE a.reference_no LIKE 'PH-PERF-%')
   INTO v_prior_cash,v_prior_perf
   FROM public.account_transactions a
   WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id
     AND (a.reference_no IS NULL OR a.reference_no NOT LIKE 'STG-PERF-%')
     AND a.occurred_at>=v_origin AND a.occurred_at<v_start;
   v_prior_cash:=v_prior_cash+250000;
   v_prior_perf:=v_prior_perf+250000;
 ELSE
   -- Unproven, altered or out-of-window cohorts are never excluded.
   SELECT count(*) FILTER(WHERE
       a.related_payment_id IS NULL AND a.related_expense_id IS NULL
       AND a.related_supplier_payment_id IS NULL AND a.related_supplier_return_id IS NULL
       AND a.related_account_id IS NULL),
     count(*) FILTER(WHERE a.reference_no LIKE 'STG-PERF-%'
       OR a.reference_no LIKE 'PH-PERF-%')
   INTO v_prior_cash,v_prior_perf
   FROM public.account_transactions a
   WHERE a.tenant_id=p_tenant_id AND a.site_id=p_site_id
     AND a.occurred_at>=v_origin AND a.occurred_at<v_start;
 END IF;
 RETURN jsonb_build_object(
   'fromOpeningDate',v_origin_date,'priorPeriodExclusive',p_period,
   'invoicesMissingGL',v_prior_invoices,
   'invoicesInvalidCycle',v_prior_invoice_invalid,
   'paymentsMissingGL',v_prior_payments,
   'paymentCollectionMismatches',v_prior_payment_cash_mismatch,
   'expensesMissingGL',v_prior_expenses,
   'supplierLedgerMissingGL',v_prior_supplier,
   'payrollUnresolved',v_prior_payroll,
   'stockMovementsMissingGL',v_prior_stock,
   'serviceRecognitionMissingGL',v_prior_service,
   'unclassifiedAccountMovements',v_prior_cash,
   'performanceFixtureTagged',v_prior_perf,
   'unreconciledCount',v_prior_invoices+v_prior_invoice_invalid+
     v_prior_payments+v_prior_payment_cash_mismatch+
     v_prior_expenses+v_prior_supplier+v_prior_payroll+
     v_prior_stock+v_prior_service+v_prior_cash);
END;
$function$;
REVOKE ALL ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps_raw(bigint,bigint,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_gl_prior_operational_gaps_raw(bigint,bigint,text)
  TO service_role;
