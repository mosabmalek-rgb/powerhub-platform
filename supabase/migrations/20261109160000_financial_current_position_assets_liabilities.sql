-- Extend the as-of financial position without fetching movement or subscriber rows.
-- Keep the existing snapshot intact; the server switches to this RPC only after
-- the versioned migration is applied. This query does not filter by report dates.
CREATE FUNCTION public.powerhub_financial_current_position_v2(
  p_tenant_id bigint, p_site_id bigint
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp
AS $position$
WITH verified_site AS (
  SELECT s.id FROM public.sites s
  WHERE s.tenant_id=p_tenant_id AND s.id=p_site_id AND s.status<>'archived'
), stock_by_location AS (
  SELECT m.warehouse_id,m.item_id,
    SUM(CASE WHEN m.movement_type IN (
      'opening_balance','purchase_receipt','adjustment_in','return_from_issue'
    ) THEN m.quantity ELSE -m.quantity END) AS quantity,
    SUM(CASE WHEN m.movement_type IN (
      'opening_balance','purchase_receipt','adjustment_in','return_from_issue'
    ) THEN m.total_cost_amount ELSE -m.total_cost_amount END) AS value
  FROM public.inventory_stock_movements m
  CROSS JOIN verified_site v
  WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
  GROUP BY m.warehouse_id,m.item_id
), stock_position AS (
  SELECT CASE WHEN COUNT(*) FILTER (WHERE quantity<0 OR value<0)>0 THEN NULL
    ELSE COALESCE(SUM(value),0) END AS amount,
    COUNT(*) FILTER (WHERE quantity<0 OR value<0) AS invalid_count
  FROM stock_by_location
), subscriber_balances AS (
  SELECT l.subscriber_id,l.balance_type,
    SUM(CASE WHEN l.direction='credit' THEN l.amount ELSE -l.amount END) AS balance
  FROM public.subscriber_balance_ledger l
  CROSS JOIN verified_site v
  WHERE l.tenant_id=p_tenant_id AND l.site_id=p_site_id
  GROUP BY l.subscriber_id,l.balance_type
), subscriber_liabilities AS (
  SELECT COALESCE(SUM(balance) FILTER (WHERE balance_type='available_credit'),0) AS credit,
    COALESCE(SUM(balance) FILTER (WHERE balance_type='security_deposit'),0) AS deposits,
    COUNT(*) FILTER (WHERE balance<0) AS invalid_count
  FROM subscriber_balances
), payroll_liability AS (
  SELECT COALESCE(SUM(r.total_net),0) AS amount
  FROM public.payroll_runs r
  CROSS JOIN verified_site v
  WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id AND r.status='approved'
)
SELECT public.powerhub_financial_current_position(p_tenant_id,p_site_id) ||
  jsonb_build_object(
    'inventoryValue',stock.amount,
    'inventoryValuationIssueCount',stock.invalid_count,
    'subscriberCreditLiability',CASE WHEN subscribers.invalid_count>0 THEN NULL ELSE subscribers.credit END,
    'securityDepositLiability',CASE WHEN subscribers.invalid_count>0 THEN NULL ELSE subscribers.deposits END,
    'subscriberLiabilityIssueCount',subscribers.invalid_count,
    'approvedPayrollPayable',payroll.amount
  )
FROM verified_site v
CROSS JOIN stock_position stock
CROSS JOIN subscriber_liabilities subscribers
CROSS JOIN payroll_liability payroll
$position$;
REVOKE ALL ON FUNCTION public.powerhub_financial_current_position_v2(bigint,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_current_position_v2(bigint,bigint)
  TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_current_position_v2(bigint,bigint)
 IS 'As-of site financial position: stock cost, subscriber credit and security deposit liabilities, and approved unpaid payroll, in addition to existing balances. Fails closed for negative ledger positions.';
NOTIFY pgrst,'reload schema';
