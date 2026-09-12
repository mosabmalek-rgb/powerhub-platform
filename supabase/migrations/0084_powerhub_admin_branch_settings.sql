create or replace function public.powerhub_admin_save_tenant_branch_settings(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_is_enabled_override boolean,
  p_max_branches_override integer,
  p_disabled_behavior text
)
returns table(tenant_id bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_tenant public.tenants%rowtype;
  v_site_id bigint;
  v_now timestamptz := now();
begin
  select * into v_actor from public.users where id=p_actor_user_id;
  if not found or v_actor.role <> 'admin' or v_actor.platform_role not in ('platform_owner','platform_admin') or v_actor.account_status <> 'active' then
    raise exception 'PLATFORM_ADMIN_FORBIDDEN' using errcode='P0001';
  end if;
  if p_disabled_behavior not in ('read_only','suspended') then
    raise exception 'INVALID_DISABLED_BEHAVIOR' using errcode='P0001';
  end if;
  if p_max_branches_override is not null and (p_max_branches_override < 1 or p_max_branches_override > 1000) then
    raise exception 'INVALID_MAX_BRANCHES' using errcode='P0001';
  end if;
  select * into v_tenant from public.tenants where id=p_tenant_id for update;
  if not found then raise exception 'TENANT_NOT_FOUND' using errcode='P0001'; end if;
  select id into v_site_id from public.sites where tenant_id=p_tenant_id and status <> 'archived' order by id limit 1;
  insert into public.tenant_branch_settings(tenant_id,is_enabled_override,max_branches_override,disabled_behavior,created_at,updated_at)
  values(p_tenant_id,p_is_enabled_override,p_max_branches_override,p_disabled_behavior,v_now,v_now)
  on conflict (tenant_id) do update set
    is_enabled_override=excluded.is_enabled_override,
    max_branches_override=excluded.max_branches_override,
    disabled_behavior=excluded.disabled_behavior,
    updated_at=v_now;
  if v_site_id is not null then
    insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(p_tenant_id,v_site_id,p_actor_user_id,v_actor.platform_role,'tenant_branch_settings',p_tenant_id::text,'platform_admin_update_branch_settings',jsonb_build_object('isEnabledOverride',p_is_enabled_override,'maxBranchesOverride',p_max_branches_override,'disabledBehavior',p_disabled_behavior));
  end if;
  insert into public.platform_security_events(event_type,severity,status,title,metadata,created_by_user_id)
  values('security_change','info','success','تحديث تفعيل الأفرع لصاحب مولد',jsonb_build_object('tenantId',p_tenant_id,'isEnabledOverride',p_is_enabled_override,'maxBranchesOverride',p_max_branches_override,'disabledBehavior',p_disabled_behavior,'actorPlatformRole',v_actor.platform_role),p_actor_user_id);
  return query select p_tenant_id,v_now;
end;
$$;

revoke execute on function public.powerhub_admin_save_tenant_branch_settings(bigint,bigint,boolean,integer,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_save_tenant_branch_settings(bigint,bigint,boolean,integer,text) to service_role;
