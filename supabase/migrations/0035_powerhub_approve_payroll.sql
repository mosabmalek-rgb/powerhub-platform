create or replace function public.powerhub_approve_payroll(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_payroll_run_id bigint
)
returns table (payroll_run_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_period text; v_status text; v_period_start timestamptz; v_period_end timestamptz; v_role text;
begin
  perform pg_advisory_xact_lock(p_site_id, hashtext('payroll-approve:' || p_payroll_run_id::text));
  select period,status into v_period,v_status from public.payroll_runs
    where id=p_payroll_run_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
  if not found then raise exception 'PAYROLL_RUN_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_status <> 'draft' then raise exception 'PAYROLL_RUN_NOT_DRAFT' using errcode='P0001'; end if;
  v_period_start := (v_period || '-01')::date;
  v_period_end := v_period_start + interval '1 month' - interval '1 microsecond';
  if exists (select 1 from public.financial_settlements where tenant_id=p_tenant_id and site_id=p_site_id and status='locked' and period_start <= v_period_end and period_end >= v_period_start) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;
  update public.payroll_runs set status='approved',approved_by_user_id=p_user_id,updated_at=now() where id=p_payroll_run_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_role,'payroll_run',p_payroll_run_id::text,'approve',jsonb_build_object('period',v_period,'previousStatus',v_status,'status','approved'));
  return query select p_payroll_run_id;
end;
$$;
revoke execute on function public.powerhub_approve_payroll(bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_approve_payroll(bigint,bigint,bigint,bigint) to service_role;
