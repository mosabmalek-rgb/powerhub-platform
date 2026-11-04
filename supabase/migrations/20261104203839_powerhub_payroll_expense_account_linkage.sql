-- Make payroll expense-to-cash linkage explicit rather than relying on reference-number inference.
DO $preflight$
BEGIN
  IF to_regprocedure('public.powerhub_pay_payroll(bigint,bigint,bigint,bigint,bigint)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='expenses' AND column_name='company_account_id'
     )
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='account_transactions' AND column_name='site_id'
     )
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='account_transactions' AND column_name='related_expense_id'
     ) THEN
    RAISE EXCEPTION 'PAYROLL_EXPENSE_LINKAGE_PREREQUISITES_MISSING';
  END IF;
END
$preflight$;

create or replace function public.powerhub_pay_payroll(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_payroll_run_id bigint, p_account_id bigint
)
returns table (payroll_run_id bigint, expense_id bigint, transaction_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_run public.payroll_runs%rowtype; v_account public.company_accounts%rowtype; v_period_start timestamptz; v_period_end timestamptz;
  v_balance numeric(14,2); v_expense_id bigint; v_transaction_id bigint; v_role text; v_allocation record; v_remaining numeric(12,2); v_allocation_count integer:=0;
  v_allocation_total numeric(14,2); v_expected_recovery numeric(14,2);
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':payroll-pay:'||p_site_id::text||':'||p_payroll_run_id::text,0));
  select * into v_run from public.payroll_runs where id=p_payroll_run_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
  if not found then raise exception 'PAYROLL_RUN_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_run.status <> 'approved' then raise exception 'PAYROLL_RUN_NOT_APPROVED' using errcode='P0001'; end if;
  v_period_start := (v_run.period || '-01')::date;
  v_period_end := v_period_start + interval '1 month' - interval '1 microsecond';
  if exists (select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and ((period_start <= v_period_end and period_end >= v_period_start) or (period_start <= now() and period_end >= now()))) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;
  if round(v_run.total_gross,2) <> round(v_run.total_deductions + v_run.total_net,2) then
    raise exception 'PAYROLL_TOTALS_INCONSISTENT' using errcode='P0001';
  end if;
  select coalesce(sum(pi.advance_deduction),0) into v_expected_recovery
    from public.payroll_items pi where pi.payroll_run_id=p_payroll_run_id;
  select coalesce(sum(pa.amount),0) into v_allocation_total
    from public.payroll_adjustment_allocations pa where pa.payroll_run_id=p_payroll_run_id;
  if round(v_allocation_total,2) <> round(v_expected_recovery,2) then
    raise exception 'ADVANCE_ALLOCATION_CONFLICT' using errcode='P0001';
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
  insert into public.expenses(tenant_id,site_id,company_account_id,category,description,amount,reference_no,created_by_user_id)
    values(p_tenant_id,p_site_id,p_account_id,'payroll','صافي الرواتب المدفوع لشهر ' || v_run.period || ' — إجمالي الأجور ' || v_run.total_gross || '، الخصومات ' || v_run.total_deductions,v_run.total_net,'PAYROLL-' || p_payroll_run_id::text,p_user_id) returning id into v_expense_id;
  insert into public.account_transactions(tenant_id,site_id,account_id,transaction_type,amount,description,reference_no,related_expense_id,created_by_user_id,occurred_at)
    values(p_tenant_id,p_site_id,p_account_id,'withdrawal',v_run.total_net,'صرف رواتب شهر ' || v_run.period,'PAYROLL-' || p_payroll_run_id::text,v_expense_id,p_user_id,now()) returning id into v_transaction_id;
  for v_allocation in
    select a.id as allocation_id,a.amount,a.adjustment_id,e.remaining_amount,e.status
    from public.payroll_adjustment_allocations a join public.employee_adjustments e on e.id=a.adjustment_id
    where a.payroll_run_id=p_payroll_run_id and e.tenant_id=p_tenant_id and e.site_id=p_site_id for update of a,e
  loop
    if v_allocation.status <> 'open' or v_allocation.remaining_amount < v_allocation.amount then raise exception 'ADVANCE_ALLOCATION_CONFLICT' using errcode='P0001'; end if;
    v_remaining := v_allocation.remaining_amount - v_allocation.amount;
    update public.employee_adjustments set remaining_amount=v_remaining,status=case when v_remaining=0 then 'settled' else 'open' end,updated_at=now() where id=v_allocation.adjustment_id;
    insert into public.employee_adjustment_repayments(
      tenant_id,site_id,adjustment_id,repayment_method,amount,company_account_id,
      account_transaction_id,payroll_run_id,payment_date,reference_no,notes,
      operation_key,operation_payload_hash,created_by_user_id
    ) values (
      p_tenant_id,p_site_id,v_allocation.adjustment_id,'payroll',v_allocation.amount,
      null,null,p_payroll_run_id,current_date,'PAYROLL-'||p_payroll_run_id::text,
      'استرداد سلفة/قسط عبر كشف الرواتب '||v_run.period,
      'PAYROLL-RECOVERY:'||p_payroll_run_id::text||':'||v_allocation.adjustment_id::text,
      md5(jsonb_build_object('payrollRunId',p_payroll_run_id,'adjustmentId',v_allocation.adjustment_id,'amount',v_allocation.amount,'period',v_run.period)::text),
      p_user_id
    );
    v_allocation_count := v_allocation_count+1;
  end loop;
  update public.payroll_runs set status='paid',paid_from_account_id=p_account_id,paid_at=now(),updated_at=now() where id=p_payroll_run_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',p_payroll_run_id::text,'pay',jsonb_build_object('expenseId',v_expense_id,'transactionId',v_transaction_id,'accountId',p_account_id,'expenseAmount',v_run.total_net,'grossWagesAmount',v_run.total_gross,'netPaidAmount',v_run.total_net,'totalDeductions',v_run.total_deductions,'advanceAllocationCount',v_allocation_count,'advanceRepaymentEntries',v_allocation_count));
  return query select p_payroll_run_id,v_expense_id,v_transaction_id;
end;
$$;

REVOKE EXECUTE ON FUNCTION public.powerhub_pay_payroll(bigint,bigint,bigint,bigint,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_pay_payroll(bigint,bigint,bigint,bigint,bigint)
  TO service_role;

NOTIFY pgrst, 'reload schema';
