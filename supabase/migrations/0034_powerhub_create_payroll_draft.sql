create or replace function public.powerhub_create_payroll_draft(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_period text, p_items jsonb
)
returns table (payroll_run_id bigint, total_net numeric)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_period_start timestamptz; v_period_end timestamptz; v_payroll_run_id bigint; v_total_gross numeric(14,2):=0;
  v_total_deductions numeric(14,2):=0; v_total_net numeric(14,2):=0; v_base numeric(12,2); v_open_advances numeric(12,2);
  v_advance_deduction numeric(12,2); v_net numeric(12,2); v_calculated_items jsonb:='[]'::jsonb; v_role text; v_item record;
begin
  if p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then
    raise exception 'INVALID_PAYROLL_DRAFT_INPUT' using errcode='P0001';
  end if;
  v_period_start := (p_period || '-01')::date;
  v_period_end := v_period_start + interval '1 month' - interval '1 microsecond';
  perform pg_advisory_xact_lock(p_site_id, hashtext('payroll-draft:' || p_period));
  perform 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status <> 'archived' for share;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if exists (select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start <= v_period_end and period_end >= v_period_start) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(employee_id bigint, extra_amount numeric, advance_deduction numeric, other_deduction numeric, notes text) group by employee_id having count(*) > 1) then
    raise exception 'DUPLICATE_PAYROLL_EMPLOYEE' using errcode='P0001';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(employee_id bigint, extra_amount numeric, advance_deduction numeric, other_deduction numeric, notes text) where employee_id is null or coalesce(extra_amount,-1)<0 or coalesce(advance_deduction,-1)<0 or coalesce(other_deduction,-1)<0 or coalesce(extra_amount,0)>100000000 or coalesce(advance_deduction,0)>100000000 or coalesce(other_deduction,0)>100000000 or char_length(coalesce(notes,''))>500) then
    raise exception 'INVALID_PAYROLL_DRAFT_INPUT' using errcode='P0001';
  end if;
  if exists (select 1 from public.payroll_runs where tenant_id=p_tenant_id and site_id=p_site_id and period=p_period) then
    raise exception 'PAYROLL_PERIOD_ALREADY_EXISTS' using errcode='P0001';
  end if;
  for v_item in select * from jsonb_to_recordset(p_items) as x(employee_id bigint, extra_amount numeric, advance_deduction numeric, other_deduction numeric, notes text)
  loop
    select base_wage into v_base from public.employees where id=v_item.employee_id and tenant_id=p_tenant_id and (site_id=p_site_id or site_id is null) and employment_status='active' for share;
    if not found then raise exception 'EMPLOYEE_OUT_OF_SCOPE_OR_INACTIVE' using errcode='P0001'; end if;
    perform 1 from public.employee_adjustments where tenant_id=p_tenant_id and employee_id=v_item.employee_id and site_id=p_site_id and adjustment_type='advance' and status='open' for share;
    select coalesce(sum(remaining_amount),0) into v_open_advances from public.employee_adjustments where tenant_id=p_tenant_id and employee_id=v_item.employee_id and site_id=p_site_id and adjustment_type='advance' and status='open';
    v_advance_deduction := least(v_item.advance_deduction + v_open_advances, v_base + v_item.extra_amount);
    v_net := v_base + v_item.extra_amount - v_advance_deduction - v_item.other_deduction;
    if v_net < 0 then raise exception 'NEGATIVE_PAYROLL_NET' using errcode='P0001'; end if;
    v_total_gross := v_total_gross + v_base + v_item.extra_amount;
    v_total_deductions := v_total_deductions + v_advance_deduction + v_item.other_deduction;
    v_total_net := v_total_net + v_net;
    v_calculated_items := v_calculated_items || jsonb_build_array(jsonb_build_object('employeeId',v_item.employee_id,'baseAmount',v_base,'extraAmount',v_item.extra_amount,'advanceDeduction',v_advance_deduction,'otherDeduction',v_item.other_deduction,'netAmount',v_net,'notes',nullif(btrim(v_item.notes),'')));
  end loop;
  insert into public.payroll_runs(tenant_id,site_id,period,status,total_gross,total_deductions,total_net,created_by_user_id)
    values(p_tenant_id,p_site_id,p_period,'draft',v_total_gross,v_total_deductions,v_total_net,p_user_id) returning id into v_payroll_run_id;
  insert into public.payroll_items(payroll_run_id,employee_id,base_amount,extra_amount,advance_deduction,other_deduction,net_amount,notes)
    select v_payroll_run_id,(item->>'employeeId')::bigint,(item->>'baseAmount')::numeric,(item->>'extraAmount')::numeric,(item->>'advanceDeduction')::numeric,(item->>'otherDeduction')::numeric,(item->>'netAmount')::numeric,item->>'notes'
    from jsonb_array_elements(v_calculated_items) as item;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',v_payroll_run_id::text,'create',jsonb_build_object('period',p_period,'itemCount',jsonb_array_length(v_calculated_items),'totalGross',v_total_gross,'totalDeductions',v_total_deductions,'totalNet',v_total_net));
  return query select v_payroll_run_id,v_total_net;
end;
$$;
revoke execute on function public.powerhub_create_payroll_draft(bigint,bigint,bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.powerhub_create_payroll_draft(bigint,bigint,bigint,text,jsonb) to service_role;
