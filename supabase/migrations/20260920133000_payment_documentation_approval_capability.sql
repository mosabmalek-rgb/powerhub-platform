-- Independent tenant capability for electronic payment documentation approval.
-- This capability is intentionally separate from collectPayments.
alter table public.platform_role_policies
  drop constraint if exists platform_role_policies_capability_check;

alter table public.platform_role_policies
  add constraint platform_role_policies_capability_check
  check (capability = any (array[
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation',
    'manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit'
  ]));

drop function if exists public.powerhub_admin_save_role_policy(bigint,text,text,boolean);

create function public.powerhub_admin_save_role_policy(
  p_actor_user_id bigint,
  p_role text,
  p_capability text,
  p_is_allowed boolean
)
returns table(success boolean, policy_id bigint, role text, capability text, is_allowed boolean, replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_id bigint;
begin
  if not exists (select 1 from public.users where id=p_actor_user_id and role='admin' and account_status='active') then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='P0001';
  end if;
  if p_role not in ('owner','manager','accountant','collector','technician','viewer') then
    raise exception 'INVALID_ROLE' using errcode='P0001';
  end if;
  if p_capability not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll',
    'manageTeam','manageMessaging','viewAudit'
  ) then
    raise exception 'INVALID_CAPABILITY' using errcode='P0001';
  end if;
  insert into public.platform_role_policies(role,capability,is_allowed,updated_by_user_id,updated_at)
  values(p_role,p_capability,p_is_allowed,p_actor_user_id,now())
  on conflict(role,capability) do update
    set is_allowed=excluded.is_allowed,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()
  returning id into v_id;
  return query select true,v_id,p_role,p_capability,p_is_allowed,false;
end;
$$;

revoke execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) to service_role;

create or replace function public.powerhub_update_staff_profile_permissions(
  p_tenant_id bigint,p_site_id bigint,p_actor_user_id bigint,p_profile_id bigint,p_custom_role_id bigint,p_permissions jsonb
)
returns table(profile_id bigint,target_user_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_before jsonb; v_target_user_id bigint; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
begin
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role <> 'admin' then
    select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active';
    if v_actor_tenant_role <> 'owner' then raise exception 'STAFF_PERMISSION_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if;
  else v_actor_tenant_role:='platform_admin'; end if;
  if p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)<1 then raise exception 'INVALID_STAFF_PERMISSIONS' using errcode='P0001'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_permissions) capability(value) where capability.value not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp','approveReadings','manageTariffs','issueInvoices','collectPayments','approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit'
  )) then raise exception 'INVALID_STAFF_PERMISSION_CAPABILITY' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('staff-profile-permissions'));
  if p_custom_role_id is not null and not exists(select 1 from public.custom_permission_roles where id=p_custom_role_id and tenant_id=p_tenant_id and is_active=true for key share) then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  select to_jsonb(profile),profile.user_id into v_before,v_target_user_id from public.staff_profiles profile where profile.id=p_profile_id and profile.tenant_id=p_tenant_id and (profile.site_id=p_site_id or profile.site_id is null) for update;
  if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  update public.staff_profiles set custom_role_id=p_custom_role_id,permissions=p_permissions,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
  values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,'update_permissions',v_before,jsonb_build_object('customRoleId',p_custom_role_id,'permissions',p_permissions,'targetUserId',v_target_user_id));
  return query select p_profile_id,v_target_user_id;
end;
$$;

create or replace function public.powerhub_save_custom_permission_role(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_role_id bigint,p_name text,p_description text,p_permissions jsonb
)
returns table(role_id bigint,mutation text)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_before jsonb; v_role_id bigint; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
begin
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role <> 'admin' then
    select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_user_id and is_active=true and membership_status='active';
    if v_actor_tenant_role <> 'owner' then raise exception 'ROLE_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if;
  else v_actor_tenant_role:='platform_admin'; end if;
  if p_name is null or char_length(btrim(p_name))<2 or char_length(btrim(p_name))>120 or p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)<1 then raise exception 'INVALID_CUSTOM_ROLE_INPUT' using errcode='P0001'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_permissions) capability(value) where capability.value not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp','approveReadings','manageTariffs','issueInvoices','collectPayments','approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit'
  )) then raise exception 'INVALID_CUSTOM_ROLE_CAPABILITY' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('custom-permission-role'));
  if p_role_id is null then
    insert into public.custom_permission_roles(tenant_id,name,description,permissions,is_active,created_by_user_id) values(p_tenant_id,btrim(p_name),nullif(btrim(coalesce(p_description,'')),''),p_permissions,true,p_user_id) returning id into v_role_id;
    insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',v_role_id::text,'create',jsonb_build_object('name',btrim(p_name),'description',nullif(btrim(coalesce(p_description,'')),''),'permissions',p_permissions,'isActive',true));
    return query select v_role_id,'create'::text;
  end if;
  select to_jsonb(role) into v_before from public.custom_permission_roles role where role.id=p_role_id and role.tenant_id=p_tenant_id for update;
  if not found then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  update public.custom_permission_roles set name=btrim(p_name),description=nullif(btrim(coalesce(p_description,'')),''),permissions=p_permissions,updated_at=now() where id=p_role_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',p_role_id::text,'update',v_before,jsonb_build_object('name',btrim(p_name),'description',nullif(btrim(coalesce(p_description,'')),''),'permissions',p_permissions));
  return query select p_role_id,'update'::text;
end;
$$;

revoke execute on function public.powerhub_update_staff_profile_permissions(bigint,bigint,bigint,bigint,bigint,jsonb),public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_update_staff_profile_permissions(bigint,bigint,bigint,bigint,bigint,jsonb),public.powerhub_save_custom_permission_role(bigint,bigint,bigint,bigint,text,text,jsonb) to service_role;
