create or replace function public.powerhub_save_custom_permission_role(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_role_id bigint,
  p_name text,
  p_description text,
  p_permissions jsonb
)
returns table (role_id bigint, mutation text)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_before jsonb;
  v_role_id bigint;
  v_actor_role text;
  v_actor_platform_role text;
  v_actor_tenant_role text;
begin
  if not exists (select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role <> 'admin' then
    select role into v_actor_tenant_role from public.tenant_members
      where tenant_id=p_tenant_id and user_id=p_user_id and is_active=true and membership_status='active';
    if v_actor_tenant_role <> 'owner' then raise exception 'ROLE_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if;
  else
    v_actor_tenant_role:='platform_admin';
  end if;
  if p_name is null or char_length(btrim(p_name))<2 or char_length(btrim(p_name))>120
    or p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)<1 then
    raise exception 'INVALID_CUSTOM_ROLE_INPUT' using errcode='P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_permissions) as capability(value)
    where capability.value not in ('manageSubscribers','manageGenerators','recordReadings','accessFieldApp','approveReadings','manageTariffs','issueInvoices','collectPayments','manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit')
  ) then raise exception 'INVALID_CUSTOM_ROLE_CAPABILITY' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(p_tenant_id,hashtext('custom-permission-role'));
  if p_role_id is null then
    insert into public.custom_permission_roles(tenant_id,name,description,permissions,is_active,created_by_user_id)
      values(p_tenant_id,btrim(p_name),nullif(btrim(coalesce(p_description,'')),''),p_permissions,true,p_user_id)
      returning id into v_role_id;
    insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data)
      values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',v_role_id::text,'create',jsonb_build_object('name',btrim(p_name),'description',nullif(btrim(coalesce(p_description,'')),''),'permissions',p_permissions,'isActive',true));
    return query select v_role_id,'create'::text;
  end if;

  select to_jsonb(role) into v_before from public.custom_permission_roles role
    where role.id=p_role_id and role.tenant_id=p_tenant_id for update;
  if not found then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  update public.custom_permission_roles set name=btrim(p_name),description=nullif(btrim(coalesce(p_description,'')),''),permissions=p_permissions,updated_at=now()
    where id=p_role_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',p_role_id::text,'update',v_before,jsonb_build_object('name',btrim(p_name),'description',nullif(btrim(coalesce(p_description,'')),''),'permissions',p_permissions));
  return query select p_role_id,'update'::text;
end;
$$;

create or replace function public.powerhub_delete_custom_permission_role(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_role_id bigint
)
returns table (role_id bigint)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_before jsonb;
  v_actor_role text;
  v_actor_platform_role text;
  v_actor_tenant_role text;
begin
  if not exists (select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role <> 'admin' then
    select role into v_actor_tenant_role from public.tenant_members
      where tenant_id=p_tenant_id and user_id=p_user_id and is_active=true and membership_status='active';
    if v_actor_tenant_role <> 'owner' then raise exception 'ROLE_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if;
  else
    v_actor_tenant_role:='platform_admin';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id,hashtext('custom-permission-role'));
  select to_jsonb(role) into v_before from public.custom_permission_roles role
    where role.id=p_role_id and role.tenant_id=p_tenant_id for update;
  if not found then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  if exists (select 1 from public.staff_profiles where tenant_id=p_tenant_id and custom_role_id=p_role_id and is_active=true for key share) then
    raise exception 'CUSTOM_ROLE_LINKED' using errcode='P0001';
  end if;
  update public.custom_permission_roles set is_active=false,updated_at=now() where id=p_role_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',p_role_id::text,'delete',v_before,jsonb_build_object('isActive',false));
  return query select p_role_id;
end;
$$;

revoke execute on function public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb),public.powerhub_delete_custom_permission_role(bigint,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb),public.powerhub_delete_custom_permission_role(bigint,bigint,bigint,bigint) to service_role;
