-- Harden financial retry/idempotency contracts:
-- 1) exact duplicate settlement submissions are idempotent;
-- 2) repeated settlement status requests are no-op successes;
-- 3) repeated exceptional edits that make no data change do not create duplicate audit entries;
-- 4) payroll approval/payment retries are idempotent after a committed first attempt.

create or replace function public.powerhub_create_financial_settlement(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_total_collected numeric,
  p_total_expenses numeric,
  p_actual_cash numeric default null,
  p_notes text default null
)
returns table (settlement_id bigint)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_id bigint;
  v_role text;
  v_profit numeric(14,2);
  v_difference numeric(14,2);
  v_existing public.financial_settlements%rowtype;
begin
  if p_period_start >= p_period_end then
    raise exception 'INVALID_SETTLEMENT_PERIOD' using errcode='P0001';
  end if;
  if p_total_collected < 0 or p_total_expenses < 0 or (p_actual_cash is not null and p_actual_cash < 0) then
    raise exception 'INVALID_SETTLEMENT_AMOUNT' using errcode='P0001';
  end if;
  if not exists (
    select 1 from public.sites
    where id=p_site_id and tenant_id=p_tenant_id and status<>'archived'
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('financial-settlement-create:' || p_tenant_id::text || ':' || p_site_id::text)::bigint);

  select * into v_existing
  from public.financial_settlements
  where tenant_id=p_tenant_id
    and site_id=p_site_id
    and period_start=p_period_start
    and period_end=p_period_end
  order by id
  limit 1
  for update;

  if found then
    if v_existing.total_collected is not distinct from p_total_collected
       and v_existing.total_expenses is not distinct from p_total_expenses
       and v_existing.actual_cash is not distinct from p_actual_cash
       and v_existing.notes is not distinct from p_notes then
      return query select v_existing.id;
      return;
    end if;
    raise exception 'SETTLEMENT_PERIOD_ALREADY_EXISTS' using errcode='P0001';
  end if;

  if exists(
    select 1 from public.financial_settlements
    where tenant_id=p_tenant_id and site_id=p_site_id
      and status='locked'
      and period_start<p_period_end and p_period_start<period_end
  ) then
    raise exception 'SETTLEMENT_PERIOD_OVERLAPS_LOCKED' using errcode='P0001';
  end if;

  v_profit := p_total_collected-p_total_expenses;
  v_difference := case when p_actual_cash is null then null else p_actual_cash-v_profit end;

  insert into public.financial_settlements(
    tenant_id,site_id,period_start,period_end,total_collected,total_expenses,
    book_profit,actual_cash,difference,notes,created_by_user_id
  )
  values(
    p_tenant_id,p_site_id,p_period_start,p_period_end,p_total_collected,p_total_expenses,
    v_profit,p_actual_cash,v_difference,p_notes,p_user_id
  )
  returning id into v_id;

  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_role,'financial_settlement',v_id::text,'create',
    jsonb_build_object(
      'periodStart',p_period_start,'periodEnd',p_period_end,
      'totalCollected',p_total_collected,'totalExpenses',p_total_expenses,
      'bookProfit',v_profit,'actualCash',p_actual_cash
    )
  );
  return query select v_id;
end;
$$;

revoke execute on function public.powerhub_create_financial_settlement(bigint,bigint,bigint,timestamptz,timestamptz,numeric,numeric,numeric,text) from public, anon, authenticated;
grant execute on function public.powerhub_create_financial_settlement(bigint,bigint,bigint,timestamptz,timestamptz,numeric,numeric,numeric,text) to service_role;


create or replace function public.powerhub_set_financial_settlement_status(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_settlement_id bigint,
  p_status text
)
returns table (settlement_id bigint)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_settlement public.financial_settlements%rowtype;
  v_role text;
begin
  if p_status not in ('submitted','approved','locked') then
    raise exception 'INVALID_SETTLEMENT_STATUS' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('financial-settlement-status:' || p_tenant_id::text || ':' || p_site_id::text || ':' || p_settlement_id::text)::bigint);

  select * into v_settlement
  from public.financial_settlements
  where id=p_settlement_id and tenant_id=p_tenant_id and site_id=p_site_id
  for update;

  if not found then raise exception 'SETTLEMENT_OUT_OF_SCOPE' using errcode='P0001'; end if;

  if v_settlement.status='locked' then
    if p_status='locked' then
      return query select p_settlement_id;
      return;
    end if;
    raise exception 'SETTLEMENT_ALREADY_LOCKED' using errcode='P0001';
  end if;

  if p_status=v_settlement.status then
    return query select p_settlement_id;
    return;
  end if;

  if p_status='locked' and v_settlement.status<>'approved' then
    raise exception 'SETTLEMENT_MUST_BE_APPROVED' using errcode='P0001';
  end if;

  update public.financial_settlements
  set status=p_status,
      approved_by_user_id=case when p_status in ('approved','locked') then p_user_id else approved_by_user_id end,
      locked_at=case when p_status='locked' then now() else locked_at end,
      updated_at=now()
  where id=p_settlement_id;

  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_role,'financial_settlement',p_settlement_id::text,'status_change',
    jsonb_build_object('status',v_settlement.status),
    jsonb_build_object('status',p_status)
  );
  return query select p_settlement_id;
end;
$$;

revoke execute on function public.powerhub_set_financial_settlement_status(bigint,bigint,bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.powerhub_set_financial_settlement_status(bigint,bigint,bigint,bigint,text) to service_role;


create or replace function public.powerhub_exceptional_locked_edit(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_entity_type text,
  p_entity_id bigint,
  p_reason text,
  p_description text default null,
  p_reference_no text default null,
  p_due_date timestamptz default null,
  p_category text default null
)
returns table (before_data jsonb, after_data jsonb)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_occurred_at timestamptz;
  v_settlement_id bigint;
  v_role text;
begin
  if p_reason is null or char_length(btrim(p_reason)) < 10 then
    raise exception 'EXCEPTIONAL_EDIT_REASON_REQUIRED' using errcode='P0001';
  end if;
  if p_entity_type not in ('invoice','payment','expense') then
    raise exception 'INVALID_EXCEPTIONAL_ENTITY' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('exceptional-edit:' || p_tenant_id::text || ':' || p_site_id::text || ':' || p_entity_type || ':' || p_entity_id::text)::bigint);

  if p_entity_type='invoice' then
    select to_jsonb(i), i.due_date into v_before,v_occurred_at
    from public.invoices i
    where i.id=p_entity_id and i.tenant_id=p_tenant_id and i.site_id=p_site_id
    for update;
    if not found then raise exception 'EXCEPTIONAL_ENTITY_OUT_OF_SCOPE' using errcode='P0001'; end if;
    if p_due_date is null then raise exception 'INVALID_EXCEPTIONAL_FIELDS' using errcode='P0001'; end if;
  elsif p_entity_type='payment' then
    select to_jsonb(p), p.paid_at into v_before,v_occurred_at
    from public.payments p
    where p.id=p_entity_id and p.tenant_id=p_tenant_id and p.site_id=p_site_id
    for update;
    if not found then raise exception 'EXCEPTIONAL_ENTITY_OUT_OF_SCOPE' using errcode='P0001'; end if;
    if p_reference_no is null then raise exception 'INVALID_EXCEPTIONAL_FIELDS' using errcode='P0001'; end if;
  else
    select to_jsonb(e), e.occurred_at into v_before,v_occurred_at
    from public.expenses e
    where e.id=p_entity_id and e.tenant_id=p_tenant_id and e.site_id=p_site_id
    for update;
    if not found then raise exception 'EXCEPTIONAL_ENTITY_OUT_OF_SCOPE' using errcode='P0001'; end if;
    if p_description is null and p_reference_no is null and p_category is null then
      raise exception 'INVALID_EXCEPTIONAL_FIELDS' using errcode='P0001';
    end if;
  end if;

  select id into v_settlement_id
  from public.financial_settlements
  where tenant_id=p_tenant_id and site_id=p_site_id and status='locked'
    and period_start <= v_occurred_at and period_end >= v_occurred_at
  limit 1;
  if v_settlement_id is null then raise exception 'EXCEPTIONAL_EDIT_NOT_LOCKED' using errcode='P0001'; end if;

  if p_entity_type='invoice' then
    if (v_before->>'due_date')::timestamptz is not distinct from p_due_date then
      return query select v_before,v_before;
      return;
    end if;
    update public.invoices set due_date=p_due_date,updated_at=now() where id=p_entity_id returning to_jsonb(invoices.*) into v_after;
  elsif p_entity_type='payment' then
    if v_before->>'reference_no' is not distinct from p_reference_no then
      return query select v_before,v_before;
      return;
    end if;
    update public.payments set reference_no=p_reference_no,updated_at=now() where id=p_entity_id returning to_jsonb(payments.*) into v_after;
  else
    if coalesce(v_before->>'description','') is not distinct from coalesce(p_description,v_before->>'description','')
       and coalesce(v_before->>'reference_no','') is not distinct from coalesce(p_reference_no,v_before->>'reference_no','')
       and coalesce(v_before->>'category','') is not distinct from coalesce(p_category,v_before->>'category','') then
      return query select v_before,v_before;
      return;
    end if;
    update public.expenses
    set description=coalesce(p_description,description),
        reference_no=coalesce(p_reference_no,reference_no),
        category=coalesce(p_category,category),
        updated_at=now()
    where id=p_entity_id
    returning to_jsonb(expenses.*) into v_after;
  end if;

  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_role,p_entity_type,p_entity_id::text,'exceptional_edit_locked',
    v_before,v_after,
    jsonb_build_object(
      'reason',p_reason,
      'reasonCode',case when p_reason like 'تراجع سريع%' then 'Reversal' else 'Correction' end,
      'settlementId',v_settlement_id
    )
  );
  return query select v_before,v_after;
end;
$$;

revoke execute on function public.powerhub_exceptional_locked_edit(bigint,bigint,bigint,text,bigint,text,text,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.powerhub_exceptional_locked_edit(bigint,bigint,bigint,text,bigint,text,text,timestamptz,text) to service_role;


create or replace function public.powerhub_approve_payroll(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_payroll_run_id bigint
)
returns table (payroll_run_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_period text;
  v_status text;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_role text;
begin
  perform pg_advisory_xact_lock(hashtext('payroll-approve:' || p_site_id::text || ':' || p_payroll_run_id::text)::bigint);
  select period,status into v_period,v_status
  from public.payroll_runs
  where id=p_payroll_run_id and tenant_id=p_tenant_id and site_id=p_site_id
  for update;
  if not found then raise exception 'PAYROLL_RUN_OUT_OF_SCOPE' using errcode='P0001'; end if;

  if v_status in ('approved','paid') then
    return query select p_payroll_run_id;
    return;
  end if;
  if v_status <> 'draft' then raise exception 'PAYROLL_RUN_NOT_DRAFT' using errcode='P0001'; end if;

  v_period_start := (v_period || '-01')::date;
  v_period_end := v_period_start + interval '1 month' - interval '1 microsecond';
  if exists (
    select 1 from public.financial_settlements
    where tenant_id=p_tenant_id and site_id=p_site_id and status='locked'
      and period_start <= v_period_end and period_end >= v_period_start
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  update public.payroll_runs
  set status='approved',approved_by_user_id=p_user_id,updated_at=now()
  where id=p_payroll_run_id;

  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',p_payroll_run_id::text,'approve',
    jsonb_build_object('period',v_period,'previousStatus',v_status,'status','approved')
  );
  return query select p_payroll_run_id;
end;
$$;

revoke execute on function public.powerhub_approve_payroll(bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_approve_payroll(bigint,bigint,bigint,bigint) to service_role;


create or replace function public.powerhub_pay_payroll(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_payroll_run_id bigint,
  p_account_id bigint
)
returns table (payroll_run_id bigint, expense_id bigint, transaction_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_run public.payroll_runs%rowtype;
  v_account public.company_accounts%rowtype;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_balance numeric(14,2);
  v_expense_id bigint;
  v_transaction_id bigint;
  v_existing_expense_id bigint;
  v_existing_transaction_id bigint;
  v_role text;
  v_allocation record;
  v_remaining numeric(12,2);
  v_allocation_count integer:=0;
begin
  perform pg_advisory_xact_lock(hashtext('payroll-pay:' || p_site_id::text || ':' || p_payroll_run_id::text)::bigint);
  select * into v_run
  from public.payroll_runs
  where id=p_payroll_run_id and tenant_id=p_tenant_id and site_id=p_site_id
  for update;
  if not found then raise exception 'PAYROLL_RUN_OUT_OF_SCOPE' using errcode='P0001'; end if;

  if v_run.status='paid' then
    if v_run.paid_from_account_id is distinct from p_account_id then
      raise exception 'PAYROLL_ALREADY_PAID' using errcode='P0001';
    end if;
    select id into v_existing_expense_id
    from public.expenses
    where tenant_id=p_tenant_id and site_id=p_site_id and category='payroll'
      and reference_no='PAYROLL-' || p_payroll_run_id::text
    order by id
    limit 1;
    select id into v_existing_transaction_id
    from public.account_transactions
    where tenant_id=p_tenant_id and account_id=p_account_id
      and transaction_type='withdrawal'
      and reference_no='PAYROLL-' || p_payroll_run_id::text
    order by id
    limit 1;
    if v_existing_expense_id is null or v_existing_transaction_id is null then
      raise exception 'PAYROLL_ALREADY_PAID_INTEGRITY_ERROR' using errcode='P0001';
    end if;
    return query select p_payroll_run_id,v_existing_expense_id,v_existing_transaction_id;
    return;
  end if;

  if v_run.status <> 'approved' then raise exception 'PAYROLL_RUN_NOT_APPROVED' using errcode='P0001'; end if;

  v_period_start := (v_run.period || '-01')::date;
  v_period_end := v_period_start + interval '1 month' - interval '1 microsecond';
  if exists (
    select 1 from public.financial_settlements
    where tenant_id=p_tenant_id and site_id=p_site_id and status='locked'
      and ((period_start <= v_period_end and period_end >= v_period_start) or (period_start <= now() and period_end >= now()))
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  select * into v_account from public.company_accounts
  where id=p_account_id and tenant_id=p_tenant_id and is_active=true
  for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites where account_id=p_account_id)
     and not exists(select 1 from public.company_account_sites where account_id=p_account_id and tenant_id=p_tenant_id and site_id=p_site_id) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select v_account.opening_balance + coalesce(sum(
    case when transaction_type in ('deposit','transfer_in','collection') then amount else -amount end
  ),0) into v_balance
  from public.account_transactions
  where tenant_id=p_tenant_id and account_id=p_account_id;
  if v_balance < v_run.total_net then raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001'; end if;

  insert into public.expenses(
    tenant_id,site_id,category,description,amount,reference_no,created_by_user_id
  )
  values(
    p_tenant_id,p_site_id,'payroll','صرف رواتب شهر ' || v_run.period,
    v_run.total_net,'PAYROLL-' || p_payroll_run_id::text,p_user_id
  )
  returning id into v_expense_id;

  insert into public.account_transactions(
    tenant_id,account_id,transaction_type,amount,description,reference_no,created_by_user_id,occurred_at
  )
  values(
    p_tenant_id,p_account_id,'withdrawal',v_run.total_net,
    'صرف رواتب شهر ' || v_run.period,'PAYROLL-' || p_payroll_run_id::text,p_user_id,now()
  )
  returning id into v_transaction_id;

  for v_allocation in
    select a.id as allocation_id,a.amount,a.adjustment_id,e.remaining_amount,e.status
    from public.payroll_adjustment_allocations a
    join public.employee_adjustments e on e.id=a.adjustment_id
    where a.payroll_run_id=p_payroll_run_id and e.tenant_id=p_tenant_id and e.site_id=p_site_id
    for update of a,e
  loop
    if v_allocation.status <> 'open' or v_allocation.remaining_amount < v_allocation.amount then
      raise exception 'ADVANCE_ALLOCATION_CONFLICT' using errcode='P0001';
    end if;
    v_remaining := v_allocation.remaining_amount - v_allocation.amount;
    update public.employee_adjustments
    set remaining_amount=v_remaining,
        status=case when v_remaining=0 then 'settled' else 'open' end,
        updated_at=now()
    where id=v_allocation.adjustment_id;
    v_allocation_count := v_allocation_count+1;
  end loop;

  update public.payroll_runs
  set status='paid',paid_from_account_id=p_account_id,paid_at=now(),updated_at=now()
  where id=p_payroll_run_id;

  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',p_payroll_run_id::text,'pay',
    jsonb_build_object(
      'expenseId',v_expense_id,'transactionId',v_transaction_id,
      'accountId',p_account_id,'amount',v_run.total_net,
      'advanceAllocationCount',v_allocation_count
    )
  );
  return query select p_payroll_run_id,v_expense_id,v_transaction_id;
end;
$$;

revoke execute on function public.powerhub_pay_payroll(bigint,bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_pay_payroll(bigint,bigint,bigint,bigint,bigint) to service_role;
