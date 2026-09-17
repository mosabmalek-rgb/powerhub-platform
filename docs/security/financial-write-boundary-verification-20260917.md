Production financial state is now mutation-only through the audited server/RPC boundary for company accounts, account transactions, invoices, invoice lines, payments, expenses, financial settlements, payroll runs, payroll items, and payroll adjustment allocations.

Direct INSERT, UPDATE, DELETE, and TRUNCATE privileges were revoked from public, anon, and authenticated. service_role retains the existing write privileges.

The matching canonical migration is `20260917214500_harden_financial_table_write_boundary.sql`.
