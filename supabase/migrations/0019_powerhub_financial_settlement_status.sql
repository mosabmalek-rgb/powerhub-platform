create or replace function public.powerhub_set_financial_settlement_status(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_settlement_id bigint, p_status text)
returns table (settlement_id bigint)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_settlement public.financial_settlements%rowtype; v_role text;
begin
  if p_status not in ('submitted','approved','locked') then raise exception 'INVALID_SETTLEMENT_STATUS' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(p_settlement_id);
  select * into v_settlement from public.financial_settlements where id=p_settlement_id and tenant_id=p_tenant_id and site_id=p_site_id for update;
  if not found then raise exception 'SETTLEMENT_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
  if v_settlement.status='locked' then raise exception 'SETTLEMENT_ALREADY_LOCKED' using errcode = 'P0001'; end if;
  if p_status='locked' and v_settlement.status <> 'approved' then raise exception 'SETTLEMENT_MUST_BE_APPROVED' using errcode = 'P0001'; end if;
  update public.financial_settlements set status=p_status, approved_by_user_id=case when p_status in ('approved','locked') then p_user_id else approved_by_user_id end, locked_at=case when p_status='locked' then now() else locked_at end, updated_at=now() where id=p_settlement_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs (tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data)
  values (p_tenant_id,p_site_id,p_user_id,v_role,'financial_settlement',p_settlement_id::text,'status_change',jsonb_build_object('status',v_settlement.status),jsonb_build_object('status',p_status));
  return query select p_settlement_id;
end;
$$;
revoke execute on function public.powerhub_set_financial_settlement_status(bigint,bigint,bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.powerhub_set_financial_settlement_status(bigint,bigint,bigint,bigint,text) to service_role;
