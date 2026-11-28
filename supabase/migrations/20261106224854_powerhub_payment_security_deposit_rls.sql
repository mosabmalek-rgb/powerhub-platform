-- Security deposits and their refunds are subscriber liabilities, not collection receipts.
DROP POLICY IF EXISTS payments_financial_capability_read ON public.payments;
CREATE POLICY payments_financial_capability_read ON public.payments FOR SELECT TO authenticated
USING (
 CASE WHEN payment_purpose IN ('security_deposit','security_deposit_refund')
 THEN private.powerhub_has_site_capability(tenant_id,site_id,'viewFinancialReports')
 ELSE private.powerhub_has_site_capability(tenant_id,site_id,'collectPayments')
   OR private.powerhub_has_site_capability(tenant_id,site_id,'viewFinancialReports')
 END
);
COMMENT ON POLICY payments_financial_capability_read ON public.payments IS
 'Collectors can read invoice collections and subscriber credit; deposits and refunds require viewFinancialReports.';
NOTIFY pgrst, 'reload schema';
