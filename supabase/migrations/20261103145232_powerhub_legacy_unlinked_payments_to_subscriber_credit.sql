-- Reclassify historical completed cash receipts without an invoice as subscriber credit.
-- The old payment RPC allowed p_invoice_id=NULL but recorded those payments as ordinary
-- invoice_collection rows. The 2026-11 credit-ledger backfill must not treat that cash as
-- invoice-applied collection: it remains a subscriber liability until applied to an invoice.
--
-- This migration is forward-only and replay-safe. It does not create another cash transaction;
-- the original account_transactions row remains the authoritative cash receipt.

with reclassified as (
  update public.payments p
  set payment_purpose = 'subscriber_credit',
      invoice_applied_amount = 0,
      subscriber_credit_amount = round(p.amount, 2)
  where p.invoice_id is null
    and p.status = 'completed'
    and coalesce(p.payment_purpose, 'invoice_collection') = 'invoice_collection'
    and p.amount > 0
  returning
    p.id,
    p.tenant_id,
    p.site_id,
    p.subscriber_id,
    p.amount,
    p.payment_no,
    p.collected_by_user_id
),
ledger_receipts as (
  insert into public.subscriber_balance_ledger (
    tenant_id,
    site_id,
    subscriber_id,
    balance_type,
    entry_type,
    direction,
    amount,
    payment_id,
    idempotency_key,
    created_by_user_id,
    metadata
  )
  select
    r.tenant_id,
    r.site_id,
    r.subscriber_id,
    'available_credit',
    'receipt',
    'credit',
    round(r.amount, 2),
    r.id,
    'subscriber-credit:payment:' || r.id::text,
    r.collected_by_user_id,
    jsonb_build_object(
      'paymentNo', r.payment_no,
      'invoiceId', null,
      'cashReceived', round(r.amount, 2),
      'invoiceAppliedAmount', 0,
      'subscriberCreditAmount', round(r.amount, 2),
      'source', 'legacy_unlinked_payment_backfill'
    )
  from reclassified r
  where not exists (
    select 1
    from public.subscriber_balance_ledger l
    where l.payment_id = r.id
      and l.balance_type = 'available_credit'
      and l.entry_type = 'receipt'
      and l.direction = 'credit'
  )
  on conflict (idempotency_key) do nothing
  returning payment_id
)
insert into public.audit_logs (
  tenant_id,
  site_id,
  user_id,
  entity_type,
  entity_id,
  action,
  before_data,
  after_data,
  metadata
)
select
  r.tenant_id,
  r.site_id,
  null,
  'payment',
  r.id::text,
  'legacy_unlinked_payment_reclassified_as_subscriber_credit',
  jsonb_build_object(
    'paymentPurpose', 'invoice_collection',
    'invoiceAppliedAmount', round(r.amount, 2),
    'subscriberCreditAmount', 0
  ),
  jsonb_build_object(
    'paymentPurpose', 'subscriber_credit',
    'invoiceAppliedAmount', 0,
    'subscriberCreditAmount', round(r.amount, 2)
  ),
  jsonb_build_object(
    'sourceMigration', '20261103160000_powerhub_legacy_unlinked_payments_to_subscriber_credit',
    'ledgerReceiptReconciled', true
  )
from reclassified r;

-- Also repair any completed, already-classified unlinked credit payment whose ledger
-- receipt is missing (for example, a row created by a pre-ledger compatibility path).
update public.payments p
set invoice_applied_amount = 0,
    subscriber_credit_amount = round(p.amount, 2)
where p.invoice_id is null
  and p.status = 'completed'
  and p.payment_purpose = 'subscriber_credit'
  and p.amount > 0
  and (
    p.invoice_applied_amount is distinct from 0
    or p.subscriber_credit_amount is distinct from round(p.amount, 2)
  );

insert into public.subscriber_balance_ledger (
  tenant_id,
  site_id,
  subscriber_id,
  balance_type,
  entry_type,
  direction,
  amount,
  payment_id,
  idempotency_key,
  created_by_user_id,
  metadata
)
select
  p.tenant_id,
  p.site_id,
  p.subscriber_id,
  'available_credit',
  'receipt',
  'credit',
  round(p.amount, 2),
  p.id,
  'subscriber-credit:payment:' || p.id::text,
  p.collected_by_user_id,
  jsonb_build_object(
    'paymentNo', p.payment_no,
    'invoiceId', null,
    'cashReceived', round(p.amount, 2),
    'invoiceAppliedAmount', 0,
    'subscriberCreditAmount', round(p.amount, 2),
    'source', 'legacy_unlinked_payment_backfill'
  )
from public.payments p
where p.invoice_id is null
  and p.status = 'completed'
  and p.payment_purpose = 'subscriber_credit'
  and p.amount > 0
  and p.invoice_applied_amount = 0
  and p.subscriber_credit_amount = round(p.amount, 2)
  and not exists (
    select 1
    from public.subscriber_balance_ledger l
    where l.payment_id = p.id
      and l.balance_type = 'available_credit'
      and l.entry_type = 'receipt'
      and l.direction = 'credit'
  )
on conflict (idempotency_key) do nothing;
