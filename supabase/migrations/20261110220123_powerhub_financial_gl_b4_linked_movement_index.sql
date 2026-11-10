-- B4.5: optimize linked financial-account provenance scans without indexing
-- the 250,000 prelaunch benchmark rows, which intentionally have no source link.
-- Only the small, source-linked subset enters this index. No data is modified.
CREATE INDEX IF NOT EXISTS account_transactions_b4_linked_site_time_idx
ON public.account_transactions (tenant_id,site_id,occurred_at,id)
WHERE related_payment_id IS NOT NULL
 OR related_supplier_payment_id IS NOT NULL
 OR related_expense_id IS NOT NULL
 OR related_supplier_return_id IS NOT NULL
 OR related_account_id IS NOT NULL;
