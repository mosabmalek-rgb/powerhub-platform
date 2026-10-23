-- Reconcile the payroll-period check on databases where the regex was over-escaped.
-- Some existing staging schemas store two backslashes before d, rejecting valid periods such as 2026-10.
alter table public.payroll_runs
  drop constraint if exists payroll_runs_period_check;

alter table public.payroll_runs
  add constraint payroll_runs_period_check
  check (period ~ '^\d{4}-\d{2}$');
