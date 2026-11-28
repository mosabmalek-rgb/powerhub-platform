-- Server-side aggregation of invoice service cycles. No invoice rows leave PostgreSQL.
-- This is BILLED value, never recognized revenue or certified profit.
-- SQL index is scoped to tenant/site; it also supports multi-year reporting.
CREATE INDEX IF NOT EXISTS invoices_financial_service_cycle_end_idx
  ON public.invoices (tenant_id, site_id, cycle_end_at)
  INCLUDE (cycle_start_at)
  WHERE status IN ('issued','overdue','partially_paid','paid')
    AND cycle_start_at IS NOT NULL AND cycle_end_at IS NOT NULL;

-- A small partial index for invoices which cannot be allocated to a cycle.
-- Their issue dates alone cannot establish earned revenue for the period.
CREATE INDEX IF NOT EXISTS invoices_financial_missing_cycle_issue_idx
  ON public.invoices (tenant_id, site_id, issue_date)
  WHERE status IN ('issued','overdue','partially_paid','paid')
    AND (cycle_start_at IS NULL OR cycle_end_at IS NULL);

CREATE OR REPLACE FUNCTION public.powerhub_financial_service_cycle_billing_aggregate(
  p_tenant_id bigint,
  p_site_id bigint,
  p_start_date date,
  p_end_date date,
  p_as_of timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $cycle_billing$
DECLARE
  v_result jsonb;
  v_invalid_count bigint;
  v_missing_count bigint;
  v_lower timestamptz;
  v_upper timestamptz;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id <= 0
    OR p_site_id IS NULL OR p_site_id <= 0
    OR p_start_date IS NULL OR p_end_date IS NULL
    OR p_start_date > p_end_date OR p_as_of IS NULL THEN
    RAISE EXCEPTION 'INVALID_FINANCIAL_CYCLE_RANGE' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sites s
    WHERE s.tenant_id = p_tenant_id AND s.id = p_site_id AND s.status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_CYCLE_SITE_OUT_OF_SCOPE' USING ERRCODE = '22023';
  END IF;

  -- Widened UTC predicates let the partial btree index prune dates safely.
  -- Exact boundary checks below use Gaza-local calendar days, including DST.
  v_lower := ((p_start_date - 2)::timestamp AT TIME ZONE 'UTC');
  v_upper := ((p_end_date + 3)::timestamp AT TIME ZONE 'UTC');

  SELECT COUNT(*) INTO v_missing_count
  FROM public.invoices i
  WHERE i.tenant_id = p_tenant_id AND i.site_id = p_site_id
    AND i.status IN ('issued','overdue','partially_paid','paid')
    AND (i.cycle_start_at IS NULL OR i.cycle_end_at IS NULL)
    AND i.issue_date >= v_lower AND i.issue_date < v_upper
    AND (i.issue_date AT TIME ZONE 'Asia/Gaza')::date BETWEEN p_start_date AND p_end_date;

  WITH candidates AS (
    SELECT i.total_amount, i.tax_amount, i.issue_date,
      i.cycle_start_at, i.cycle_end_at,
      (i.cycle_start_at AT TIME ZONE 'Asia/Gaza')::date AS service_first,
      (i.cycle_end_at AT TIME ZONE 'Asia/Gaza')::date AS service_last,
      (i.issue_date AT TIME ZONE 'Asia/Gaza')::date AS issue_day
    FROM public.invoices i
    WHERE i.tenant_id = p_tenant_id AND i.site_id = p_site_id
      AND i.status IN ('issued','overdue','partially_paid','paid')
      AND i.cycle_start_at IS NOT NULL AND i.cycle_end_at IS NOT NULL
      AND i.cycle_end_at >= v_lower AND i.cycle_start_at < v_upper
  ), scoped AS (
    SELECT * FROM candidates
    WHERE service_last >= p_start_date AND service_first <= p_end_date
  ), totals AS (
    SELECT
      COUNT(*) AS invoice_count,
      COUNT(*) FILTER (WHERE cycle_start_at > cycle_end_at
        OR total_amount IS NULL OR tax_amount IS NULL
        OR total_amount < 0 OR tax_amount < 0 OR tax_amount > total_amount) AS invalid_count,
      COUNT(*) FILTER (WHERE service_first >= p_start_date AND service_last <= p_end_date) AS inside_count,
      COUNT(*) FILTER (WHERE service_first < p_start_date OR service_last > p_end_date) AS cross_count,
      COUNT(*) FILTER (WHERE cycle_end_at < p_as_of) AS completed_count,
      COUNT(*) FILTER (WHERE cycle_start_at > p_as_of) AS future_count,
      COUNT(*) FILTER (WHERE cycle_start_at <= p_as_of AND cycle_end_at >= p_as_of) AS ongoing_count,
      COUNT(*) FILTER (WHERE issue_day < p_start_date OR issue_day > p_end_date) AS issued_outside_count,
      COALESCE(SUM(total_amount),0) AS billed_gross,
      COALESCE(SUM(tax_amount),0) AS billed_tax,
      COALESCE(SUM(total_amount) FILTER (WHERE cycle_end_at < p_as_of),0) AS completed_gross,
      COALESCE(SUM(total_amount) FILTER (WHERE cycle_start_at > p_as_of),0) AS future_gross,
      COALESCE(SUM(total_amount) FILTER (
        WHERE cycle_start_at <= p_as_of AND cycle_end_at >= p_as_of),0) AS ongoing_gross,
      COALESCE(SUM(total_amount) FILTER (
        WHERE issue_day < p_start_date OR issue_day > p_end_date),0) AS issued_outside_gross
    FROM scoped
  )
  SELECT t.invalid_count,
    jsonb_build_object(
      'range',jsonb_build_object('startDate',p_start_date,'endDate',p_end_date),
      'asOf',p_as_of,
      'scopeTenantId',p_tenant_id,'scopeSiteId',p_site_id,
      'issuedInvoiceCount',t.invoice_count,
      'fullyInsideCount',t.inside_count,
      'crossBoundaryCount',t.cross_count,
      'completedCount',t.completed_count,
      'inProgressCount',t.ongoing_count,
      'futureCount',t.future_count,
      'issuedOutsideRangeCount',t.issued_outside_count,
      'missingCycleCount',v_missing_count,
      'billedGross',t.billed_gross,'billedTax',t.billed_tax,
      'billedExTax',t.billed_gross - t.billed_tax,
      'completedCycleBilledGross',t.completed_gross,
      'ongoingCycleBilledGross',t.ongoing_gross,
      'futureCycleBilledGross',t.future_gross,
      'issuedOutsideRangeBilledGross',t.issued_outside_gross,
      'isRecognizedRevenue',false,
      'isCompleteProfitAndLoss',false,
      'isCycleCoverageComplete',v_missing_count = 0,
      'coverage','invoices_with_service_cycles_intersecting_range'
    )
  INTO v_invalid_count,v_result
  FROM totals t;

  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'INVALID_FINANCIAL_CYCLE_INVOICE' USING ERRCODE = '22023';
  END IF;
  RETURN v_result;
END;
$cycle_billing$;

REVOKE ALL ON FUNCTION public.powerhub_financial_service_cycle_billing_aggregate(
  bigint,bigint,date,date,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_service_cycle_billing_aggregate(
  bigint,bigint,date,date,timestamptz) TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_service_cycle_billing_aggregate(
  bigint,bigint,date,date,timestamptz)
IS 'Service-cycle billed totals, scoped to tenant/site; does not recognize revenue. Returns warning count for missing service cycles.';
NOTIFY pgrst,'reload schema';
