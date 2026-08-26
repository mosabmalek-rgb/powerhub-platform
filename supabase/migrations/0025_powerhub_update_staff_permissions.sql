create or replace function public.powerhub_update_staff_profile_permissions(
  p_tenant_id bigint,
  p_site_id bigint,
  p_actor_user_id bigint,
  p_profile_id bigint,
  p_custom_role_id bigint,
  p_permissions jsonb
)
returns table (profile_id bigint, target_user_id bigint)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_before jsonb;
  v_target_user_id bigint;
  v_actor_role text;
  v_actor_platform_role text;
  v_actor_tenant_role text;
begin
  if not exists (select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role <> 'admin' then
    select role into v_actor_tenant_role from public.tenant_members
      where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active';
    if v_actor_tenant_role <> 'owner' then raise exception 'STAFF_PERMISSION_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if;
  else
    v_actor_tenant_role:='platform_admin';
  end if;
  if p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)<1 then
    raise exception 'INVALID_STAFF_PERMISSIONS' using errcode='P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_permissions) as capability(value)
    where capability.value not in ('manageSubscribers','manageGenerators','recordReadings','accessFieldApp','approveReadings','manageTariffs','issueInvoices','collectPayments','manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit')
  ) then raise exception 'INVALID_STAFF_PERMISSION_CAPABILITY' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(p_tenant_id,hashtext('staff-profile-permissions'));
  if p_custom_role_id is not null and not exists (
    select 1 from public.custom_permission_roles where id=p_custom_role_id and tenant_id=p_tenant_id and is_active=true for key share
  ) then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  select to_jsonb(profile),profile.user_id into v_before,v_target_user_id from public.staff_profiles profile
    where profile.id=p_profile_id and profile.tenant_id=p_tenant_id and (profile.site_id=p_site_id or profile.site_id is null) for update;
  if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  update public.staff_profiles set custom_role_id=p_custom_role_id,permissions=p_permissions,updated_at=now()
    where id=p_profile_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
    values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,'update_permissions',v_before,jsonb_build_object('customRoleId',p_custom_role_id,'permissions',p_permissions,'targetUserId',v_target_user_id));
  return query select p_profile_id,v_target_user_id;
end;
$$;

revoke execute on function public.powerhub_update_staff_profile_permissions(bigint,bigint,bigint,bigint,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_update_staff_profile_permissions(bigint,bigint,bigint,bigint,bigint,jsonb) to service_role;
