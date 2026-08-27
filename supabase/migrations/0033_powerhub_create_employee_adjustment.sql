create or replace function public.powerhub_create_employee_adjustment(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_employee_id bigint,
  p_adjustment_type text, p_amount numeric, p_reason text
)
returns table (adjustment_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_adjustment_id bigint; v_role text;
begin
  if p_adjustment_type not in ('advance','deduction') or p_amount <= 0 or p_amount > 100000000 or char_length(btrim(p_reason)) < 3 then
    raise exception 'INVALID_EMPLOYEE_ADJUSTMENT_INPUT' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(p_tenant_id, hashtext('employee-adjustment-create'));
  perform 1 from public.employees
    where id=p_employee_id and tenant_id=p_tenant_id and (site_id=p_site_id or site_id is null) for share;
  if not found then raise exception 'EMPLOYEE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  insert into public.employee_adjustments(tenant_id,employee_id,site_id,adjustment_type,amount,remaining_amount,reason,status,created_by_user_id)
    values(p_tenant_id,p_employee_id,p_site_id,p_adjustment_type,p_amount,p_amount,btrim(p_reason),'open',p_user_id)
    returning id into v_adjustment_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_role,'employee_adjustment',v_adjustment_id::text,'create',jsonb_build_object('employeeId',p_employee_id,'adjustmentType',p_adjustment_type,'amount',p_amount,'reason',btrim(p_reason)));
  return query select v_adjustment_id;
end;
$$;
revoke execute on function public.powerhub_create_employee_adjustment(bigint,bigint,bigint,bigint,text,numeric,text) from public, anon, authenticated;
grant execute on function public.powerhub_create_employee_adjustment(bigint,bigint,bigint,bigint,text,numeric,text) to service_role;
