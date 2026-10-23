-- Reconcile financial/report indexes and company-account update timestamp trigger.
-- Expense linkage columns and their dedicated indexes are supplied by powerhub_expense_account_linkage.
create index if not exists account_transactions_account_id_idx
  on public.account_transactions (account_id);

create index if not exists account_transactions_payment_id_idx
  on public.account_transactions (related_payment_id);

create index if not exists account_transactions_tenant_account_date_idx
  on public.account_transactions (tenant_id, account_id, occurred_at desc);

create index if not exists audit_logs_site_id_idx
  on public.audit_logs (site_id);

create index if not exists audit_logs_tenant_site_date_idx
  on public.audit_logs (tenant_id, site_id, created_at desc);

create index if not exists audit_logs_user_id_idx
  on public.audit_logs (user_id);

create index if not exists company_accounts_tenant_idx
  on public.company_accounts (tenant_id);

create index if not exists expenses_site_created_at_idx
  on public.expenses (site_id, created_at desc);

create index if not exists expenses_site_date_idx
  on public.expenses (site_id, occurred_at desc);

create index if not exists expenses_site_occurred_at_id_desc_idx
  on public.expenses (site_id, occurred_at desc, id desc);

create index if not exists expenses_tenant_site_idx
  on public.expenses (tenant_id, site_id);

create index if not exists expenses_tenant_site_occurred_at_id_idx
  on public.expenses (tenant_id, site_id, occurred_at desc, id desc);

drop trigger if exists company_accounts_set_updated_at on public.company_accounts;
create trigger company_accounts_set_updated_at
before update on public.company_accounts
for each row execute function public.powerhub_set_updated_at();
