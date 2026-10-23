-- Isolated end-to-end ledger test for employee salary advances and loans.
\set ON_ERROR_STOP on

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then execute 'create role anon nologin'; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then execute 'create role authenticated nologin'; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then execute 'create role service_role nologin bypassrls'; end if;
end
$roles$;

create table public.tenants(id bigint primary key);
create table public.users(id bigint primary key, platform_role text);
create table public.sites(id bigint primary key, tenant_id bigint not null, status text not null default 'active');
create table public.financial_settlements(
  id bigint generated always as identity primary key, tenant_id bigint not null, site_id bigint not null,
  period_start timestamptz not null, period_end timestamptz not null, status text not null
);
create table public.employees(
  id bigint generated always as identity primary key, tenant_id bigint not null, site_id bigint,
  linked_user_id bigint, full_name text not null, identity_no text, phone text,
  job_title text not null, employment_status text not null, contract_type text not null,
  base_wage numeric(12,2) not null, hire_date timestamptz, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.company_accounts(
  id bigint generated always as identity primary key, tenant_id bigint not null, name text not null,
  account_type text not null, opening_balance numeric(14,2) not null default 0,
  is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.company_account_sites(
  id bigint generated always as identity primary key, tenant_id bigint not null, account_id bigint not null,
  site_id bigint not null, unique(account_id,site_id)
);
create table public.account_transactions(
  id bigint generated always as identity primary key, tenant_id bigint not null, account_id bigint not null,
  transaction_type text not null, amount numeric(14,2) not null, description text not null,
  reference_no text, related_payment_id bigint, related_account_id bigint, created_by_user_id bigint,
  occurred_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.expenses(
  id bigint generated always as identity primary key, tenant_id bigint not null, site_id bigint not null,
  category text not null, description text not null, amount numeric(14,2) not null,
  occurred_at timestamptz not null default now(), reference_no text, created_by_user_id bigint
);
create table public.audit_logs(
  id bigint generated always as identity primary key, tenant_id bigint not null, site_id bigint not null,
  user_id bigint, actor_platform_role text, entity_type text not null, entity_id text not null,
  action text not null, before_data jsonb, after_data jsonb, metadata jsonb, created_at timestamptz not null default now()
);
create table public.employee_adjustments(
  id bigint generated always as identity primary key, tenant_id bigint not null, employee_id bigint not null,
  site_id bigint, adjustment_type text not null check(adjustment_type in ('advance','deduction')),
  amount numeric(12,2) not null check(amount>0), remaining_amount numeric(12,2) not null check(remaining_amount>=0),
  reason text not null, status text not null default 'open' check(status in ('open','settled','cancelled')),
  created_by_user_id bigint not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.payroll_runs(
  id bigint generated always as identity primary key, tenant_id bigint not null, site_id bigint,
  period text not null, status text not null default 'draft', total_gross numeric(14,2) not null default 0,
  total_deductions numeric(14,2) not null default 0, total_net numeric(14,2) not null default 0,
  paid_from_account_id bigint, approved_by_user_id bigint, paid_at timestamptz,
  created_by_user_id bigint not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,site_id,period)
);
create table public.payroll_items(
  id bigint generated always as identity primary key, payroll_run_id bigint not null, employee_id bigint not null,
  base_amount numeric(12,2) not null, extra_amount numeric(12,2) not null default 0,
  advance_deduction numeric(12,2) not null default 0, other_deduction numeric(12,2) not null default 0,
  net_amount numeric(12,2) not null, notes text, unique(payroll_run_id,employee_id)
);

insert into public.tenants values (1),(2);
insert into public.users values (10,'tenant_owner'),(20,'tenant_owner');
insert into public.sites(id,tenant_id,status) values (100,1,'active'),(200,2,'active');
insert into public.employees(tenant_id,site_id,full_name,job_title,employment_status,contract_type,base_wage)
values (1,100,'موظف اختبار السلف','worker','active','monthly',1000),
       (2,200,'موظف مستأجر آخر','worker','active','monthly',800);
insert into public.company_accounts(tenant_id,name,account_type,opening_balance)
values (1,'صندوق الفرع','cash',5000),(2,'صندوق مستأجر آخر','cash',5000);
insert into public.company_account_sites(tenant_id,account_id,site_id) values (1,1,100),(2,2,200);

\ir ../migrations/20261023194500_powerhub_employee_advances_loans.sql

do $test$
declare
  v_salary_advance_id bigint; v_loan_id bigint; v_tx bigint; v_remaining numeric; v_replayed boolean;
  v_payroll_id bigint; v_net numeric; v_salary_status text; v_loan_remaining numeric; v_balance numeric;
  v_before_transactions integer; v_repayment_id bigint; v_second_payroll_id bigint; v_third_payroll_id bigint; v_cancelled boolean;
begin
  -- Legacy generic adjustment endpoint must not create advances without an account transaction.
  begin
    perform * from public.powerhub_create_employee_adjustment(1,100,10,1,'advance',50,'اختبار منع السلفة القديمة');
    raise exception 'EXPECTED_LEGACY_ADVANCE_BLOCK';
  exception when others then
    if sqlerrm not in ('USE_EMPLOYEE_ADVANCE_RPC','EXPECTED_LEGACY_ADVANCE_BLOCK') then raise; end if;
    if sqlerrm='EXPECTED_LEGACY_ADVANCE_BLOCK' then raise; end if;
  end;
  if (select count(*) from public.employee_adjustments where tenant_id=1)<>0 then
    raise exception 'LEGACY_ADVANCE_BLOCK_CREATED_SIDE_EFFECT';
  end if;

  -- Reject insufficient cash before creating either a receivable or cash transaction.
  begin
    perform * from public.powerhub_issue_employee_advance(1,100,10,1,'salary_advance',5001,null,1,'2026-10-04','اختبار رصيد غير كاف','issue-insufficient-1');
    raise exception 'EXPECTED_INSUFFICIENT_ACCOUNT_BALANCE';
  exception when others then
    if sqlerrm not in ('INSUFFICIENT_ACCOUNT_BALANCE','EXPECTED_INSUFFICIENT_ACCOUNT_BALANCE') then raise; end if;
    if sqlerrm='EXPECTED_INSUFFICIENT_ACCOUNT_BALANCE' then raise; end if;
  end;
  if (select count(*) from public.employee_adjustments where tenant_id=1)<>0
    or (select count(*) from public.account_transactions where tenant_id=1)<>0 then
    raise exception 'INSUFFICIENT_CASH_CREATED_SIDE_EFFECTS';
  end if;

  -- Issue a salary advance and ensure replays never make a second withdrawal.
  select adjustment_id,account_transaction_id,remaining_amount,replayed
    into v_salary_advance_id,v_tx,v_remaining,v_replayed
    from public.powerhub_issue_employee_advance(1,100,10,1,'salary_advance',200,null,1,'2026-10-05','سلفة قبل موعد الراتب','issue-salary-1');
  if v_remaining<>200 or v_replayed then raise exception 'ADVANCE_ISSUE_RESULT_FAILED'; end if;
  select count(*) into v_before_transactions from public.account_transactions where tenant_id=1;
  select adjustment_id,account_transaction_id,remaining_amount,replayed
    into v_salary_advance_id,v_tx,v_remaining,v_replayed
    from public.powerhub_issue_employee_advance(1,100,10,1,'salary_advance',200,null,1,'2026-10-05','سلفة قبل موعد الراتب','issue-salary-1');
  if not v_replayed or v_remaining<>200 then raise exception 'ADVANCE_IDEMPOTENT_REPLAY_FAILED'; end if;
  if (select count(*) from public.account_transactions where tenant_id=1)<>v_before_transactions then raise exception 'ADVANCE_REPLAY_DUPLICATED_WITHDRAWAL'; end if;

  -- Idempotency keys cannot be reused for a different payload.
  begin
    perform * from public.powerhub_issue_employee_advance(1,100,10,1,'salary_advance',201,null,1,'2026-10-05','سلفة قبل موعد الراتب','issue-salary-1');
    raise exception 'EXPECTED_IDEMPOTENCY_KEY_REUSED';
  exception when others then
    if sqlerrm not in ('IDEMPOTENCY_KEY_REUSED','EXPECTED_IDEMPOTENCY_KEY_REUSED') then raise; end if;
    if sqlerrm='EXPECTED_IDEMPOTENCY_KEY_REUSED' then raise; end if;
  end;

  select adjustment_id into v_loan_id
    from public.powerhub_issue_employee_advance(1,100,10,1,'employee_loan',500,100,1,'2026-10-06','قرض موظف بقسط شهري','issue-loan-1');
  if (select count(*) from public.employee_adjustments where tenant_id=1 and adjustment_type='advance')<>2 then raise exception 'ADVANCE_COUNT_FAILED'; end if;
  if (select count(*) from public.account_transactions where tenant_id=1 and transaction_type='withdrawal')<>2 then raise exception 'ADVANCE_WITHDRAWAL_COUNT_FAILED'; end if;

  select payroll_run_id,total_net into v_payroll_id,v_net
    from public.powerhub_create_payroll_draft(1,100,10,'2026-10',
      jsonb_build_array(jsonb_build_object('employee_id',1,'extra_amount',0,'advance_deduction',0,'other_deduction',0,'notes',null)));
  if v_net<>700 then raise exception 'FIRST_PAYROLL_NET_EXPECTED_700_GOT_%',v_net; end if;
  if (select total_gross from public.payroll_runs where id=v_payroll_id)<>1000 then raise exception 'PAYROLL_GROSS_FAILED'; end if;
  if (select total_deductions from public.payroll_runs where id=v_payroll_id)<>300 then raise exception 'PAYROLL_ADVANCE_AND_INSTALLMENT_DEDUCTIONS_FAILED'; end if;
  if (select sum(amount) from public.payroll_adjustment_allocations where payroll_run_id=v_payroll_id)<>300 then raise exception 'PAYROLL_RESERVATIONS_FAILED'; end if;
  if (select amount from public.payroll_adjustment_allocations where payroll_run_id=v_payroll_id and adjustment_id=v_salary_advance_id)<>200 then raise exception 'SALARY_ADVANCE_ALLOCATION_FAILED'; end if;
  if (select amount from public.payroll_adjustment_allocations where payroll_run_id=v_payroll_id and adjustment_id=v_loan_id)<>100 then raise exception 'LOAN_INSTALLMENT_ALLOCATION_FAILED'; end if;

  perform * from public.powerhub_approve_payroll(1,100,10,v_payroll_id);
  perform * from public.powerhub_pay_payroll(1,100,10,v_payroll_id,1);
  select status into v_salary_status from public.employee_adjustments where id=v_salary_advance_id;
  if v_salary_status<>'settled' then raise exception 'SALARY_ADVANCE_NOT_SETTLED_AFTER_PAYROLL'; end if;
  select remaining_amount into v_loan_remaining from public.employee_adjustments where id=v_loan_id;
  if v_loan_remaining<>400 then raise exception 'LOAN_BALANCE_AFTER_PAYROLL_EXPECTED_400_GOT_%',v_loan_remaining; end if;
  if (select total_gross-total_deductions from public.payroll_runs where id=v_payroll_id)<>v_net then raise exception 'PAYROLL_GROSS_DEDUCTIONS_NET_DO_NOT_RECONCILE'; end if;
  if (select count(*) from public.employee_adjustment_repayments where payroll_run_id=v_payroll_id and repayment_method='payroll')<>2 then raise exception 'PAYROLL_REPAYMENT_LEDGER_COUNT_FAILED'; end if;
  if (select sum(amount) from public.employee_adjustment_repayments where payroll_run_id=v_payroll_id and repayment_method='payroll')<>300 then raise exception 'PAYROLL_REPAYMENT_LEDGER_TOTAL_FAILED'; end if;
  if (select amount from public.employee_adjustment_repayments where payroll_run_id=v_payroll_id and adjustment_id=v_salary_advance_id and repayment_method='payroll')<>200 then raise exception 'SALARY_ADVANCE_PAYROLL_REPAYMENT_ENTRY_FAILED'; end if;
  if (select amount from public.employee_adjustment_repayments where payroll_run_id=v_payroll_id and adjustment_id=v_loan_id and repayment_method='payroll')<>100 then raise exception 'LOAN_PAYROLL_REPAYMENT_ENTRY_FAILED'; end if;
  if exists(select 1 from public.employee_adjustment_repayments where payroll_run_id=v_payroll_id and repayment_method='payroll' and (company_account_id is not null or account_transaction_id is not null)) then raise exception 'PAYROLL_REPAYMENT_MUST_NOT_CREATE_DUPLICATE_CASH_MOVEMENT'; end if;
  if (select amount from public.expenses where reference_no='PAYROLL-'||v_payroll_id::text)<>700 then raise exception 'PAYROLL_EXPENSE_MUST_MATCH_NET_CASH_PAID'; end if;
  if (select amount from public.account_transactions where reference_no='PAYROLL-'||v_payroll_id::text)<>700 then raise exception 'PAYROLL_WITHDRAWAL_MUST_EQUAL_NET_PAY'; end if;
  begin
    perform * from public.powerhub_pay_payroll(1,100,10,v_payroll_id,1);
    raise exception 'EXPECTED_DUPLICATE_PAYROLL_PAYMENT_GUARD';
  exception when others then
    if sqlerrm not in ('PAYROLL_RUN_NOT_APPROVED','EXPECTED_DUPLICATE_PAYROLL_PAYMENT_GUARD') then raise; end if;
    if sqlerrm='EXPECTED_DUPLICATE_PAYROLL_PAYMENT_GUARD' then raise; end if;
  end;
  if (select count(*) from public.employee_adjustment_repayments where payroll_run_id=v_payroll_id and repayment_method='payroll')<>2 then raise exception 'DUPLICATE_PAYROLL_PAYMENT_CREATED_REPAYMENTS'; end if;

  -- Next month reserves one loan installment; direct repayment cannot spend the reserved amount.
  select payroll_run_id,total_net into v_second_payroll_id,v_net
    from public.powerhub_create_payroll_draft(1,100,10,'2026-11',
      jsonb_build_array(jsonb_build_object('employee_id',1,'extra_amount',0,'advance_deduction',0,'other_deduction',0,'notes',null)));
  if v_net<>900 then raise exception 'SECOND_PAYROLL_NET_EXPECTED_900_GOT_%',v_net; end if;
  begin
    perform * from public.powerhub_repay_employee_advance(1,100,10,v_loan_id,1,350,'2026-11-03',null,null,'repay-too-much-1');
    raise exception 'EXPECTED_RESERVED_BALANCE_GUARD';
  exception when others then
    if sqlerrm not in ('ADVANCE_BALANCE_RESERVED','EXPECTED_RESERVED_BALANCE_GUARD') then raise; end if;
    if sqlerrm='EXPECTED_RESERVED_BALANCE_GUARD' then raise; end if;
  end;

  select repayment_id,remaining_amount into v_repayment_id,v_loan_remaining
    from public.powerhub_repay_employee_advance(1,100,10,v_loan_id,1,50,'2026-11-03','CASH-REC-1','سداد جزئي','repay-loan-1');
  if v_loan_remaining<>350 then raise exception 'PARTIAL_REPAYMENT_BALANCE_EXPECTED_350_GOT_%',v_loan_remaining; end if;
  select repayment_id,remaining_amount into v_repayment_id,v_loan_remaining
    from public.powerhub_repay_employee_advance(1,100,10,v_loan_id,1,50,'2026-11-03','CASH-REC-1','سداد جزئي','repay-loan-1');
  if v_loan_remaining<>350 or (select count(*) from public.account_transactions where reference_no='EMP-REPAY:repay-loan-1')<>1 then raise exception 'REPAYMENT_IDEMPOTENCY_FAILED'; end if;

  perform * from public.powerhub_approve_payroll(1,100,10,v_second_payroll_id);
  perform * from public.powerhub_pay_payroll(1,100,10,v_second_payroll_id,1);
  select remaining_amount into v_loan_remaining from public.employee_adjustments where id=v_loan_id;
  if v_loan_remaining<>250 then raise exception 'LOAN_BALANCE_AFTER_SECOND_INSTALLMENT_EXPECTED_250_GOT_%',v_loan_remaining; end if;
  if (select count(*) from public.employee_adjustment_repayments where payroll_run_id=v_second_payroll_id and adjustment_id=v_loan_id and repayment_method='payroll')<>1 then raise exception 'SECOND_MONTH_LOAN_REPAYMENT_ENTRY_FAILED'; end if;
  if (select amount from public.employee_adjustment_repayments where payroll_run_id=v_second_payroll_id and adjustment_id=v_loan_id and repayment_method='payroll')<>100 then raise exception 'SECOND_MONTH_LOAN_INSTALLMENT_AMOUNT_FAILED'; end if;
  select 5000+coalesce(sum(case when transaction_type in ('deposit','transfer_in','collection') then amount else -amount end),0)
    into v_balance from public.account_transactions where tenant_id=1 and account_id=1;
  if v_balance<>2750 then raise exception 'CASH_BALANCE_EXPECTED_2750_GOT_%',v_balance; end if;

  -- A draft reserves installments; it blocks overlapping future payrolls until safely cancelled or paid.
  select payroll_run_id into v_third_payroll_id
  from public.powerhub_create_payroll_draft(1,100,10,'2026-12',
    jsonb_build_array(jsonb_build_object('employee_id',1,'extra_amount',0,'advance_deduction',0,'other_deduction',0,'notes',null)));
  begin
    perform * from public.powerhub_create_payroll_draft(1,100,10,'2027-01',
      jsonb_build_array(jsonb_build_object('employee_id',1,'extra_amount',0,'advance_deduction',0,'other_deduction',0,'notes',null)));
    raise exception 'EXPECTED_OPEN_PAYROLL_RUN_GUARD';
  exception when others then
    if sqlerrm not in ('PAYROLL_OPEN_RUN_EXISTS','EXPECTED_OPEN_PAYROLL_RUN_GUARD') then raise; end if;
    if sqlerrm='EXPECTED_OPEN_PAYROLL_RUN_GUARD' then raise; end if;
  end;

  select cancelled into v_cancelled
  from public.powerhub_cancel_payroll_draft(1,100,10,v_third_payroll_id);
  if not v_cancelled or (select status from public.payroll_runs where id=v_third_payroll_id)<>'cancelled' then
    raise exception 'PAYROLL_DRAFT_CANCEL_FAILED';
  end if;

  -- Cancelled runs remain auditable but must not prevent a corrected draft for the same period.
  select payroll_run_id into v_third_payroll_id
  from public.powerhub_create_payroll_draft(1,100,10,'2026-12',
    jsonb_build_array(jsonb_build_object('employee_id',1,'extra_amount',0,'advance_deduction',0,'other_deduction',0,'notes',null)));
  select cancelled into v_cancelled
  from public.powerhub_cancel_payroll_draft(1,100,10,v_third_payroll_id);
  if not v_cancelled then raise exception 'REBUILT_PAYROLL_DRAFT_CANCEL_FAILED'; end if;

  -- Unlinked manual advance deductions must not silently reduce pay outside the advance ledger.
  begin
    perform * from public.powerhub_create_payroll_draft(1,100,10,'2027-02',
      jsonb_build_array(jsonb_build_object('employee_id',1,'extra_amount',0,'advance_deduction',1,'other_deduction',0,'notes',null)));
    raise exception 'EXPECTED_UNLINKED_ADVANCE_DEDUCTION_GUARD';
  exception when others then
    if sqlerrm not in ('INVALID_PAYROLL_DRAFT_INPUT','EXPECTED_UNLINKED_ADVANCE_DEDUCTION_GUARD') then raise; end if;
    if sqlerrm='EXPECTED_UNLINKED_ADVANCE_DEDUCTION_GUARD' then raise; end if;
  end;

  begin
    perform * from public.powerhub_repay_employee_advance(2,200,20,v_loan_id,2,1,'2026-11-04',null,null,'cross-tenant-repay');
    raise exception 'EXPECTED_TENANT_ISOLATION';
  exception when others then
    if sqlerrm not in ('ADVANCE_OUT_OF_SCOPE','EXPECTED_TENANT_ISOLATION') then raise; end if;
    if sqlerrm='EXPECTED_TENANT_ISOLATION' then raise; end if;
  end;

  if has_function_privilege('authenticated','public.powerhub_issue_employee_advance(bigint,bigint,bigint,bigint,text,numeric,numeric,bigint,date,text,text)','EXECUTE') then raise exception 'AUTHENTICATED_CAN_EXECUTE_ISSUE_RPC'; end if;
  if has_function_privilege('authenticated','public.powerhub_create_employee_adjustment(bigint,bigint,bigint,bigint,text,numeric,text)','EXECUTE') then raise exception 'AUTHENTICATED_CAN_EXECUTE_LEGACY_ADJUSTMENT_RPC'; end if;
  if has_function_privilege('authenticated','public.powerhub_repay_employee_advance(bigint,bigint,bigint,bigint,bigint,numeric,date,text,text,text)','EXECUTE') then raise exception 'AUTHENTICATED_CAN_EXECUTE_REPAY_RPC'; end if;
  if not has_function_privilege('service_role','public.powerhub_issue_employee_advance(bigint,bigint,bigint,bigint,text,numeric,numeric,bigint,date,text,text)','EXECUTE') then raise exception 'SERVICE_ROLE_CANNOT_EXECUTE_ISSUE_RPC'; end if;
  if has_function_privilege('authenticated','public.powerhub_cancel_payroll_draft(bigint,bigint,bigint,bigint)','EXECUTE') then raise exception 'AUTHENTICATED_CAN_EXECUTE_CANCEL_PAYROLL_RPC'; end if;
  if not has_function_privilege('service_role','public.powerhub_cancel_payroll_draft(bigint,bigint,bigint,bigint)','EXECUTE') then raise exception 'SERVICE_ROLE_CANNOT_EXECUTE_CANCEL_PAYROLL_RPC'; end if;
  if has_function_privilege('authenticated','public.powerhub_approve_payroll(bigint,bigint,bigint,bigint)','EXECUTE') then raise exception 'AUTHENTICATED_CAN_EXECUTE_APPROVE_PAYROLL_RPC'; end if;
  if has_function_privilege('authenticated','public.powerhub_pay_payroll(bigint,bigint,bigint,bigint,bigint)','EXECUTE') then raise exception 'AUTHENTICATED_CAN_EXECUTE_PAYROLL_RPC'; end if;
end
$test$;

select 'EMPLOYEE_ADVANCES_LOANS_INTEGRATION_OK' as result;
