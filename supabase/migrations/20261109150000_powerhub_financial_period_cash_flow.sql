-- Period cash flow uses posted company account movements, not invoice income.
-- Exclude internal transfers from gross cash flow to avoid double counting.
-- Scope to site-attributed movements only; legacy unassigned movements must not
-- be silently allocated to a branch. Company balance belongs to the separate
-- current-position RPC and does not use this period filter.
CREATE OR REPLACE FUNCTION public.powerhub_financial_period_cash_flow(
  p_tenant_id bigint, p_site_id bigint,
  p_period_start timestamptz, p_period_end_exclusive timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp
AS $period_flow$
  SELECT jsonb_build_object(
    'asOf', now(),
    'scopeSiteId',p_site_id,
    'externalCashIn',COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type IN ('collection','deposit')),0),
    'externalCashOut',COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='withdrawal'),0),
    'netCashFlow',COALESCE(SUM(CASE
      WHEN t.transaction_type IN ('collection','deposit') THEN t.amount
      WHEN t.transaction_type='withdrawal' THEN -t.amount
      ELSE 0 END),0),
    'internalTransferVolume',COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='transfer_out'),0),
    'transactionCount',COUNT(*) FILTER (
      WHERE t.transaction_type IN ('collection','deposit','withdrawal')),
    'scopeNotice','site_attributed_only'
  )
  FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
    AND t.occurred_at>=p_period_start AND t.occurred_at<p_period_end_exclusive
$period_flow$;
REVOKE ALL ON FUNCTION public.powerhub_financial_period_cash_flow(
  bigint,bigint,timestamptz,timestamptz
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_period_cash_flow(
  bigint,bigint,timestamptz,timestamptz
) TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_period_cash_flow(
  bigint,bigint,timestamptz,timestamptz
) IS 'Period cash movements attributed to a site. Excludes internal transfers; includes capital deposits as cash, not revenue.';
NOTIFY pgrst,'reload schema';
