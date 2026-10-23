-- Direct table DML on financial ledgers bypasses domain capability checks, audited RPCs and idempotency.
-- Match production's existing access boundary while preserving authenticated reads and service-role writes.
revoke insert, update, delete, truncate
  on table public.account_transactions, public.audit_logs, public.company_accounts, public.expenses
  from anon, authenticated;
