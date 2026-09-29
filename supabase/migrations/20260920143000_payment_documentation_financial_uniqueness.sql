-- Financial hardening for electronic payment documentation.
-- Additive only: reuses existing company_accounts, payments and account_transactions.

create unique index if not exists payment_documentation_requests_pending_invoice_uidx
  on public.payment_documentation_requests(tenant_id, invoice_id)
  where status = 'pending';

create unique index if not exists payment_documentation_requests_payment_uidx
  on public.payment_documentation_requests(payment_id)
  where payment_id is not null;

-- The production implementation of these functions must preserve the existing
-- payment_documentation_v1 contract and route approved requests through
-- powerhub_create_payment. The canonical definitions are maintained in the
-- production migration history and should be applied through the same Supabase
-- migration pipeline; this migration records the financial uniqueness guards.
