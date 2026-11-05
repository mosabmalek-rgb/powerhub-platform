-- The company-account Delta trigger builds a tenant-wide recent-history
-- snapshot ordered by occurred_at/id. Existing account/site indexes are scoped
-- to one account/site first and cannot satisfy this access path.
create index if not exists account_transactions_tenant_recent_idx
  on public.account_transactions (tenant_id, occurred_at desc, id desc);
