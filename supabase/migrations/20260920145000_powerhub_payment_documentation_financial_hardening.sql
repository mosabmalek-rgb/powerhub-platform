-- Harden the payment-documentation financial bridge.
-- Keeps existing company accounts and the canonical payment flow.

create unique index if not exists payment_documentation_requests_pending_invoice_uidx
  on public.payment_documentation_requests(tenant_id, invoice_id)
  where status = 'pending';

create unique index if not exists payment_documentation_requests_payment_uidx
  on public.payment_documentation_requests(payment_id)
  where payment_id is not null;
