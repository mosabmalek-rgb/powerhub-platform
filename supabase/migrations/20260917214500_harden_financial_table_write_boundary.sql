-- Business-critical financial state must be mutated through the audited server/RPC boundary.
-- Keep authenticated/anon SELECT access intact where existing RLS policies permit it.
-- service_role retains the required write privileges.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  public.company_accounts,
  public.account_transactions,
  public.invoices,
  public.invoice_lines,
  public.payments,
  public.expenses,
  public.financial_settlements,
  public.payroll_runs,
  public.payroll_items,
  public.payroll_adjustment_allocations
FROM anon, authenticated, public;
