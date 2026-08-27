create or replace function public.powerhub_pay_payroll(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_payroll_run_id bigint, p_account_id bigint
)
returns table (payroll_run_id bigint, expense_id bigint, transaction_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_run public.payroll_runs%rowtype; v_account public.company_accounts%rowtype; v_period_start timestamptz; v_period_end timestamptz;
  v_balance numeric(14,2); v_expense_id bigint; v_transaction_id bigint; v_role text; v_allocation record; v_remaining numeric(12,2); v_allocation_count integer:=0;
begin
  perform pg_advisory_xact_lock(p_site_id, hashtext('payroll-pay:' || p_payroll_run_id::text));
  select * into v_run from public.payroll_runs where id=p_payroll_run_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
  if not found then raise exception 'PAYROLL_RUN_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_run.status <> 'approved' then raise exception 'PAYROLL_RUN_NOT_APPROVED' using errcode='P0001'; end if;
  v_period_start := (v_run.period || '-01')::date;
  v_period_end := v_period_start + interval '1 month' - interval '1 microsecond';
  if exists (select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and ((period_start <= v_period_end and period_end >= v_period_start) or (period_start <= now() and period_end >= now()))) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;
  select * into v_account from public.company_accounts where id=p_account_id and tenant_id=p_tenant_id and is_active=true for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if exists (select 1 from public.company_account_sites where account_id=p_account_id)
     and not exists (select 1 from public.company_account_sites where account_id=p_account_id and tenant_id=p_tenant_id and site_id=p_site_id) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select v_account.opening_balance + coalesce(sum(case when transaction_type in ('deposit','transfer_in','collection') then amount else -amount end),0)
    into v_balance from public.account_transactions where tenant_id=p_tenant_id and account_id=p_account_id;
  if v_balance < v_run.total_net then raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001'; end if;
  insert into public.expenses(tenant_id,site_id,category,description,amount,reference_no,created_by_user_id)
    values(p_tenant_id,p_site_id,'payroll','صرف رواتب شهر ' || v_run.period,v_run.total_net,'PAYROLL-' || p_payroll_run_id::text,p_user_id) returning id into v_expense_id;
  insert into public.account_transactions(tenant_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id,occurred_at)
    values(p_tenant_id,p_account_id,'withdrawal',v_run.total_net,'صرف رواتب شهر ' || v_run.period,'PAYROLL-' || p_payroll_run_id::text,p_user_id,now()) returning id into v_transaction_id;
  for v_allocation in
    select a.id as allocation_id,a.amount,a.adjustment_id,e.remaining_amount,e.status
    from public.payroll_adjustment_allocations a join public.employee_adjustments e on e.id=a.adjustment_id
    where a.payroll_run_id=p_payroll_run_id and e.tenant_id=p_tenant_id and e.site_id=p_site_id for update of a,e
  loop
    if v_allocation.status <> 'open' or v_allocation.remaining_amount < v_allocation.amount then raise exception 'ADVANCE_ALLOCATION_CONFLICT' using errcode='P0001'; end if;
    v_remaining := v_allocation.remaining_amount - v_allocation.amount;
    update public.employee_adjustments set remaining_amount=v_remaining,status=case when v_remaining=0 then 'settled' else 'open' end,updated_at=now() where id=v_allocation.adjustment_id;
    v_allocation_count := v_allocation_count+1;
  end loop;
  update public.payroll_runs set status='paid',paid_from_account_id=p_account_id,paid_at=now(),updated_at=now() where id=p_payroll_run_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',p_payroll_run_id::text,'pay',jsonb_build_object('expenseId',v_expense_id,'transactionId',v_transaction_id,'accountId',p_account_id,'amount',v_run.total_net,'advanceAllocationCount',v_allocation_count));
  return query select p_payroll_run_id,v_expense_id,v_transaction_id;
end;
$$;
revoke execute on function public.powerhub_pay_payroll(bigint,bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_pay_payroll(bigint,bigint,bigint,bigint,bigint) to service_role;
