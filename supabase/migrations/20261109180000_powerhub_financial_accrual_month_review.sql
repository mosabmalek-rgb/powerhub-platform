-- Financial accrual bridge: month-bound, site-scoped, read-only.
-- Cycle-completion recognition policy is provisional pending period close
-- and a full unbilled-service and cut-off reconciliation. No cash collection
-- or purchase payment is represented as earned revenue or wage expense.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_month_review(
  p_tenant_id bigint, p_site_id bigint, p_period text, p_as_of timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp
AS $accrual$
DECLARE
  v_first date;
  v_last date;
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id<=0 OR p_site_id IS NULL OR p_site_id<=0 OR
     p_period IS NULL OR p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR p_as_of IS NULL
  THEN RAISE EXCEPTION 'INVALID_ACCRUAL_REQUEST' USING ERRCODE='22023'; END IF;
  v_first := (p_period||'-01')::date;
  v_last := (v_first+INTERVAL '1 month - 1 day')::date;
  v_start := v_first::timestamp AT TIME ZONE 'Asia/Gaza';
  v_end := (v_last+1)::timestamp AT TIME ZONE 'Asia/Gaza';
  IF NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id=p_site_id AND
    s.tenant_id=p_tenant_id AND s.status<>'archived') THEN
    RAISE EXCEPTION 'ACCRUAL_SITE_OUT_OF_SCOPE' USING ERRCODE='22023';
  END IF;

  WITH issued AS (
    SELECT i.id,i.total_amount,i.tax_amount,i.cycle_start_at,i.cycle_end_at,
      i.issue_date,i.status,
      (i.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date AS first_day,
      (i.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date AS last_day,
      (i.issue_date AT TIME ZONE 'Asia/Gaza')::date AS issued_day
    FROM public.invoices i
    WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
      AND i.status IN ('issued','overdue','partially_paid','paid')
      AND i.cycle_end_at >= v_start - INTERVAL '2 days'
      AND i.cycle_end_at < v_end + INTERVAL '2 days'
  ), cycle_in_month AS (
    SELECT * FROM issued WHERE last_day BETWEEN v_first AND v_last
  ), revenue AS (
    SELECT
      COUNT(*) AS invoice_count,
      COUNT(*) FILTER (WHERE cycle_start_at IS NULL OR cycle_end_at IS NULL OR
        cycle_start_at>cycle_end_at OR total_amount<0 OR tax_amount<0 OR tax_amount>total_amount)
        AS bad_invoice_count,
      COUNT(*) FILTER (WHERE cycle_end_at<=p_as_of) AS completed_count,
      COUNT(*) FILTER (WHERE cycle_end_at>p_as_of) AS uncompleted_count,
      COUNT(*) FILTER (WHERE first_day<v_first) AS cross_period_count,
      COUNT(*) FILTER (WHERE issued_day<v_first OR issued_day>v_last) AS issued_outside_count,
      COALESCE(SUM(total_amount) FILTER (WHERE cycle_end_at<=p_as_of),0) AS gross,
      COALESCE(SUM(tax_amount) FILTER (WHERE cycle_end_at<=p_as_of),0) AS tax,
      COALESCE(SUM(total_amount) FILTER (WHERE cycle_end_at>p_as_of),0) AS uncompleted_gross
    FROM cycle_in_month
  ), missing_cycles AS (
    SELECT COUNT(*) AS n FROM public.invoices i
    WHERE i.tenant_id=p_tenant_id AND i.site_id=p_site_id
      AND i.status IN ('issued','overdue','partially_paid','paid')
      AND (i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL)
      AND i.issue_date>=v_start AND i.issue_date<v_end
  ), expense_totals AS (
    SELECT
      COUNT(*) FILTER (WHERE category='payroll') AS payout_expense_count,
      COALESCE(SUM(amount) FILTER (WHERE expense_classification='operating' AND category<>'payroll'),0) AS operating_cost,
      COALESCE(SUM(amount) FILTER (WHERE expense_classification='non_operating' AND category<>'payroll'),0) AS nonoperating_cost,
      COALESCE(SUM(amount) FILTER (WHERE category='payroll'),0) AS payroll_cash_paid,
      COUNT(*) FILTER (WHERE amount<0 OR expense_classification NOT IN ('operating','non_operating')) AS invalid_count
    FROM public.expenses
    WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND occurred_at>=v_start AND occurred_at<v_end
  ), wage_totals AS (
    SELECT
      COUNT(*) FILTER (WHERE status='draft') AS draft_count,
      COUNT(*) FILTER (WHERE status='approved') AS approved_count,
      COUNT(*) FILTER (WHERE status='paid') AS paid_count,
      COALESCE(SUM(total_gross) FILTER (WHERE status IN ('approved','paid')),0) AS gross_cost,
      COALESCE(SUM(total_net) FILTER (WHERE status IN ('approved','paid')),0) AS net_obligation,
      COALESCE(SUM(total_deductions) FILTER (WHERE status IN ('approved','paid')),0) AS deduction_total,
      COUNT(*) FILTER (WHERE status IN ('approved','paid') AND
        (total_gross<0 OR total_net<0 OR total_deductions<0 OR
          ABS(total_gross-total_net-total_deductions)>0.01)) AS invalid_count
    FROM public.payroll_runs WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND period=p_period
  ), item_issues AS (
    SELECT m.id,m.movement_type,m.total_cost_amount,i.category,i.accounting_treatment
    FROM public.inventory_stock_movements m
    JOIN public.inventory_items i ON i.tenant_id=m.tenant_id AND i.id=m.item_id
    WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
      AND m.occurred_at>=v_start AND m.occurred_at<v_end
      AND m.movement_type IN ('issue','fuel_consumption','return_from_issue')
      AND (m.movement_type='return_from_issue' OR NOT EXISTS(
        SELECT 1 FROM public.inventory_stock_movements r
        WHERE r.tenant_id=m.tenant_id AND r.site_id=m.site_id
          AND r.reversal_of_movement_id=m.id
      ))
      AND (m.movement_type<>'return_from_issue' OR EXISTS(
        SELECT 1 FROM public.inventory_stock_movements src
        WHERE src.tenant_id=m.tenant_id AND src.site_id=m.site_id AND src.id=m.source_issue_movement_id
          AND src.movement_type='issue' AND src.occurred_at<=m.occurred_at
          AND NOT EXISTS (SELECT 1 FROM public.inventory_stock_movements r
            WHERE r.tenant_id=src.tenant_id AND r.site_id=src.site_id
              AND r.reversal_of_movement_id=src.id)
      ))
  ), stock_cost AS (
    SELECT
      COALESCE(SUM(CASE WHEN movement_type='return_from_issue'
        THEN -total_cost_amount ELSE total_cost_amount END)
        FILTER (WHERE accounting_treatment='expense_on_issue'
          AND category IN ('fuel','oil','filter','maintenance_supply','spare_part')),0) AS cost,
      COUNT(*) FILTER (WHERE accounting_treatment IS NULL OR
        accounting_treatment NOT IN ('expense_on_issue','capital_asset','inventory_asset') OR
        (accounting_treatment='expense_on_issue' AND
          category NOT IN ('fuel','oil','filter','maintenance_supply','spare_part'))) AS unclassified_count,
      COUNT(*) FILTER (WHERE total_cost_amount<0) AS invalid_count
    FROM item_issues
  ), purchase_totals AS (
    SELECT COUNT(*) AS purchase_count,
      COALESCE(SUM(total_amount) FILTER (WHERE status IN ('confirmed','received')),0) AS recorded_purchase_gross
    FROM public.supplier_purchases WHERE tenant_id=p_tenant_id AND site_id=p_site_id
      AND invoice_date BETWEEN v_first AND v_last
  ), cash_settlement AS (
    SELECT COUNT(*) AS legacy_settlement_count FROM public.financial_settlements
      WHERE tenant_id=p_tenant_id AND site_id=p_site_id AND
        period_start<v_end AND period_end>=v_start
  )
  SELECT jsonb_build_object(
    'scopeTenantId',p_tenant_id,'scopeSiteId',p_site_id,'period',p_period,'asOf',p_as_of,
    'recognitionPolicy','completed_service_cycle_on_end_date',
    'invoiceCount',r.invoice_count,'completedInvoiceCount',r.completed_count,
    'uncompletedInvoiceCount',r.uncompleted_count,'crossPeriodInvoiceCount',r.cross_period_count,
    'issuedOutsideServiceMonthCount',r.issued_outside_count,
    'missingCycleCount',mc.n,'invalidInvoiceCount',r.bad_invoice_count,
    'billedGrossCompleted',r.gross,'billedTaxCompleted',r.tax,
    'serviceBillingExTax',r.gross-r.tax,'uncompletedBillingGross',r.uncompleted_gross,
    'operatingDirectExpenses',e.operating_cost,'nonOperatingDirectExpenses',e.nonoperating_cost,
    'payrollCashPaid',e.payroll_cash_paid,'payrollCashExpenseCount',e.payout_expense_count,
    'payrollGrossCost',w.gross_cost,'payrollNetObligation',w.net_obligation,
    'payrollDeductions',w.deduction_total,'draftPayrollCount',w.draft_count,
    'approvedPayrollCount',w.approved_count,'paidPayrollCount',w.paid_count,
    'inventoryConsumptionCost',sc.cost,'unclassifiedInventoryIssueCount',sc.unclassified_count,
    'purchaseCount',pu.purchase_count,'purchaseGrossNotExpensed',pu.recorded_purchase_gross,
    'legacyCashSettlementCount',cs.legacy_settlement_count,
    'invalidPayrollCount',w.invalid_count,'invalidExpenseCount',e.invalid_count,
    'invalidInventoryCount',sc.invalid_count,
    'contributionBeforePeriodAdjustments',
      (r.gross-r.tax)-e.operating_cost-w.gross_cost-sc.cost,
    'provisionalNetBeforePeriodAdjustments',
      (r.gross-r.tax)-e.operating_cost-w.gross_cost-sc.cost-e.nonoperating_cost,
    'isFinalProfit',false,
    'isCompleteAccrualStatement',false,
    'limitation','Unbilled service, journal adjustments, depreciation, provisions and cut-off reconciliation require approved closing'
  ) INTO v_result
  FROM revenue r CROSS JOIN missing_cycles mc CROSS JOIN expense_totals e
    CROSS JOIN wage_totals w CROSS JOIN stock_cost sc CROSS JOIN purchase_totals pu
    CROSS JOIN cash_settlement cs;
  IF (v_result->>'invalidInvoiceCount')::bigint>0 OR
     (v_result->>'invalidExpenseCount')::bigint>0 OR
     (v_result->>'invalidPayrollCount')::bigint>0 OR
     (v_result->>'invalidInventoryCount')::bigint>0 THEN
    RAISE EXCEPTION 'ACCRUAL_SOURCE_RECONCILIATION_FAILED' USING ERRCODE='22023';
  END IF;
  RETURN v_result;
END;
$accrual$;

REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_month_review(bigint,bigint,text,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_month_review(bigint,bigint,text,timestamptz)
  TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_accrual_month_review(bigint,bigint,text,timestamptz)
 IS 'Provisional accrual components for one site/month. Excludes purchase payments and payroll payout costs from P&L; final profit requires approved journal and closing.';
NOTIFY pgrst,'reload schema';
