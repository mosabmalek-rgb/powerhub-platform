-- Available subscriber credit is pooled; it is not tied to an individual security-deposit receipt.
-- Security-deposit applications/refunds remain debit-only and linked to their originating receipt.
alter table public.subscriber_balance_ledger
  drop constraint if exists subscriber_balance_ledger_refund_source_check;

alter table public.subscriber_balance_ledger
  add constraint subscriber_balance_ledger_refund_source_check check (
    (
      balance_type = 'security_deposit'
      and entry_type in ('refund','application')
      and direction = 'debit'
      and source_ledger_id is not null
    )
    or (
      balance_type = 'available_credit'
      and entry_type = 'application'
      and direction = 'debit'
      and invoice_id is not null
      and source_ledger_id is null
    )
    or (
      balance_type = 'available_credit'
      and entry_type = 'refund'
      and source_ledger_id is null
    )
    or (
      entry_type not in ('refund','application')
      and source_ledger_id is null
    )
  );
