-- Financial current-position snapshot for the financial dashboard.
-- A point-in-time snapshot: NEVER apply a selected report period to balances.
-- All site/tenant scope and feature permissions are enforced by the server
-- before calling this service-role-only, read-only SECURITY INVOKER function.
CREATE OR REPLACE FUNCTION public.powerhub_financial_current_position(
  p_tenant_id bigint,
  p_site_id bigint
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $snapshot$
WITH verified_site AS (
  SELECT s.id FROM public.sites s WHERE s.id=p_site_id
    AND s.tenant_id=p_tenant_id AND s.status<>'archived'
), accessible_accounts AS (
  SELECT a.id, a.name, a.account_type, a.opening_balance,
    NOT EXISTS (
      SELECT 1 FROM public.company_account_sites l
      WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id
    ) OR EXISTS (
      SELECT 1 FROM public.company_account_sites l
      WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id AND l.site_id <> p_site_id
    ) AS is_shared
  FROM public.company_accounts a
  CROSS JOIN verified_site v
  WHERE a.tenant_id = p_tenant_id
    AND a.is_active = TRUE
    AND (
      NOT EXISTS (
        SELECT 1 FROM public.company_account_sites l
        WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id
      ) OR EXISTS (
        SELECT 1 FROM public.company_account_sites l
        WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id AND l.site_id = p_site_id
      )
    )
), balances AS (
  SELECT a.id, a.name, a.account_type, a.is_shared,
    a.opening_balance + COALESCE(tx.net_change,0) AS balance
  FROM accessible_accounts a
  LEFT JOIN LATERAL (
    SELECT SUM(CASE
      WHEN t.transaction_type IN ('collection','deposit','transfer_in') THEN t.amount
      ELSE -t.amount
    END) AS net_change
    FROM public.account_transactions t
    WHERE t.tenant_id = p_tenant_id AND t.account_id = a.id
  ) tx ON TRUE
), supplier_balances AS (
  SELECT l.supplier_id,
    SUM(l.credit_amount - l.debit_amount) AS balance
  FROM public.supplier_ledger_entries l
  CROSS JOIN verified_site v
  WHERE l.tenant_id = p_tenant_id AND l.site_id = p_site_id
  GROUP BY l.supplier_id
), payroll_advances AS (
  SELECT COALESCE(SUM(GREATEST(e.remaining_amount,0)),0) AS amount
  FROM public.employee_adjustments e
  CROSS JOIN verified_site v
  WHERE e.tenant_id = p_tenant_id AND e.site_id = p_site_id
    AND e.adjustment_type = 'advance'
    AND e.remaining_amount > 0
    AND e.status NOT IN ('cancelled','reversed','settled','closed')
), debtor_invoices AS (
  SELECT COALESCE(SUM(GREATEST(i.balance_due,0)),0) AS amount
  FROM public.invoices i
  CROSS JOIN verified_site v
  WHERE i.tenant_id = p_tenant_id AND i.site_id = p_site_id
    AND i.status NOT IN ('draft','cancelled','void')
    AND i.balance_due > 0
), cash AS (
  SELECT COALESCE(SUM(b.balance),0) AS total,
    COUNT(*) AS account_count,
    COUNT(*) FILTER (WHERE b.is_shared) AS shared_count,
    COALESCE(jsonb_agg(jsonb_build_object(
      'id',b.id,'name',b.name,'type',b.account_type,
      'balance',b.balance,'shared',b.is_shared
    ) ORDER BY b.name,b.id), '[]'::jsonb) AS accounts
  FROM balances b
)
SELECT jsonb_build_object(
  'asOf', now(),
  'scopeSiteId', p_site_id,
  'cashBalance', cash.total,
  'accountCount', cash.account_count,
  'sharedAccountCount', cash.shared_count,
  'accounts', cash.accounts,
  'supplierPayables', (SELECT COALESCE(SUM(GREATEST(s.balance,0)),0) FROM supplier_balances s),
  'supplierPrepayments', (SELECT COALESCE(SUM(GREATEST(-s.balance,0)),0) FROM supplier_balances s),
  'employeeAdvances', (SELECT amount FROM payroll_advances),
  'subscriberReceivables', (SELECT amount FROM debtor_invoices)
)
FROM cash
$snapshot$;
REVOKE ALL ON FUNCTION public.powerhub_financial_current_position(bigint,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_current_position(bigint,bigint)
  TO service_role;
COMMENT ON FUNCTION public.powerhub_financial_current_position(bigint,bigint)
 IS 'Point-in-time financial account balances, supplier net liabilities and receivables, advance balances, and outstanding subscriber invoices for an authorized site; excludes report period filtering.';
NOTIFY pgrst, 'reload schema';
