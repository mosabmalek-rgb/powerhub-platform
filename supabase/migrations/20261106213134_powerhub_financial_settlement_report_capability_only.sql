-- Financial settlement records contain profit, cash and reconciliation details.
-- Expense-management permission alone must not expose these reports.
DROP POLICY IF EXISTS financial_settlements_financial_capability_read ON public.financial_settlements;
CREATE POLICY financial_settlements_report_capability_read
ON public.financial_settlements FOR SELECT TO authenticated
USING (
  private.powerhub_has_site_capability(tenant_id,site_id,'viewFinancialReports')
);
NOTIFY pgrst, 'reload schema';
