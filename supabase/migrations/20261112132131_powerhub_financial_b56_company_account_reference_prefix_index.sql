-- B5.6 support reference prefix search in account transactions for ALL tenants/sites.
-- This does not change the classification, evidence, or quarantine rules.
CREATE INDEX IF NOT EXISTS account_transactions_tenant_site_reference_prefix_idx
 ON public.account_transactions
 (tenant_id,site_id,reference_no text_pattern_ops)
 WHERE reference_no IS NOT NULL;
