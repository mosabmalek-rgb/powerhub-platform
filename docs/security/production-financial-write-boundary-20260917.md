# Production financial write boundary — 2026-09-17

Production verification found that authenticated and anonymous roles retained direct INSERT/UPDATE/DELETE/TRUNCATE table privileges on business-critical financial tables even though application writes use server-side RPC/service-role paths.

The canonical hardening migration `20260917214500_harden_financial_table_write_boundary.sql` revokes direct client writes from `public`, `anon`, and `authenticated` for:

- company_accounts
- account_transactions
- invoices
- invoice_lines
- payments
- expenses
- financial_settlements
- payroll_runs
- payroll_items
- payroll_adjustment_allocations

`service_role` retains the existing write privileges.

Production was updated through the matching Supabase migration before this source-control record was created.
