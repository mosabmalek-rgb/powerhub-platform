-- Speed up financial-period cash aggregates across all accounts in a branch.
-- The account-first history indexes cannot provide a tight range scan when a
-- settlement previews every account movement for one tenant/site/date window.
CREATE INDEX IF NOT EXISTS account_transactions_tenant_site_occurred_idx
  ON public.account_transactions (tenant_id, site_id, occurred_at DESC, id DESC)
  WHERE site_id IS NOT NULL;
