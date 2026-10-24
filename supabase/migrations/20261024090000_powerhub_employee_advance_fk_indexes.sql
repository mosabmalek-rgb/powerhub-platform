-- Add leading-column indexes for foreign keys on the employee repayment ledger.
-- Existing tenant-prefixed composite indexes are retained for tenant-scoped reads,
-- but cannot efficiently support FK checks that begin with account/site/user/adjustment IDs.
create index if not exists employee_adjustment_repayments_account_transaction_id_idx
  on public.employee_adjustment_repayments(account_transaction_id);
create index if not exists employee_adjustment_repayments_adjustment_id_idx
  on public.employee_adjustment_repayments(adjustment_id);
create index if not exists employee_adjustment_repayments_company_account_id_idx
  on public.employee_adjustment_repayments(company_account_id);
create index if not exists employee_adjustment_repayments_created_by_user_id_idx
  on public.employee_adjustment_repayments(created_by_user_id);
create index if not exists employee_adjustment_repayments_payroll_run_id_idx
  on public.employee_adjustment_repayments(payroll_run_id);
create index if not exists employee_adjustment_repayments_site_id_idx
  on public.employee_adjustment_repayments(site_id);
create index if not exists employee_adjustments_created_by_user_id_idx
  on public.employee_adjustments(created_by_user_id);
create index if not exists employee_adjustments_disbursement_account_id_idx
  on public.employee_adjustments(disbursement_account_id);
create index if not exists employee_adjustments_employee_id_idx
  on public.employee_adjustments(employee_id);
create index if not exists employee_adjustments_site_id_idx
  on public.employee_adjustments(site_id);

