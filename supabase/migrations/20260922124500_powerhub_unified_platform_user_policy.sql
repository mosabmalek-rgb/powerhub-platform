-- Route the existing staff-assignment RPC through unified platform/field user policies.
-- Preserve the existing RPC signature and role/tenant checks.
create or replace function public.powerhub_assign_existing_staff(
  p_tenant_id bigint,
  p_site_id bigint,
  p_actor_user_id bigint,
  p_target_user_id bigint,
  p_role text,
  p_all_branches boolean
)
returns table (profile_id bigint, target_user_id bigint)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_actor_role text;
  v_actor_platform_role text;
  v_actor_tenant_role text;
  v_existing_member_role text;
  v_existing_member_active boolean;
  v_existing_membership_status text;
  v_target_membership_role text;
  v_target_site_id bigint;
  v_plan text;
  v_policy_enabled boolean;
  v_roles_policy jsonb;
  v_limits_policy jsonb;
  v_overrides_policy jsonb;
  v_override jsonb;
  v_limit_text text;
  v_override_limit_text text;
  v_limit integer;
  v_current_count integer;
  v_platform_policy record;
  v_field_policy record;
  v_already_active_subaccount boolean := false;
  v_before_member jsonb;
  v_before_profiles jsonb;
  v_profile_id bigint;
begin
  if p_role not in ('owner','manager','accountant','collector','technician','viewer') then
    raise exception 'INVALID_STAFF_ROLE' using errcode='P0001';
  end if;
  if not exists (select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select role, platform_role into v_actor_role, v_actor_platform_role from public.users where id=p_actor_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if not exists (select 1 from public.users where id=p_target_user_id) then
    raise exception 'TARGET_USER_NOT_FOUND' using errcode='P0001';
  end if;
  if v_actor_role <> 'admin' then
    select role into v_actor_tenant_role from public.tenant_members
      where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active';
    if v_actor_tenant_role <> 'owner' then raise exception 'STAFF_ASSIGNMENT_FORBIDDEN' using errcode='P0001'; end if;
  else
    v_actor_tenant_role := 'platform_admin';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id, hashtext('staff-assignment'));
  select to_jsonb(member), member.role, member.is_active, member.membership_status
    into v_before_member, v_existing_member_role, v_existing_member_active, v_existing_membership_status
    from public.tenant_members member where member.tenant_id=p_tenant_id and member.user_id=p_target_user_id for update;
  v_already_active_subaccount := found and v_existing_member_role='member' and v_existing_member_active=true and v_existing_membership_status='active';
  v_target_membership_role := case when found and v_existing_member_role='owner' then 'owner' else 'member' end;
  v_target_site_id := case when p_all_branches then null else p_site_id end;

  select coalesce(jsonb_agg(to_jsonb(profile)), '[]'::jsonb) into v_before_profiles
    from public.staff_profiles profile
    where profile.tenant_id=p_tenant_id and profile.user_id=p_target_user_id
      and (profile.site_id=p_site_id or (p_all_branches and profile.site_id is null));

  select package_code into v_plan from public.tenant_subscriptions where tenant_id=p_tenant_id;
  if v_plan is null then raise exception 'TENANT_PACKAGE_NOT_FOUND' using errcode='P0002'; end if;
  if v_plan not in ('basic','advanced','professional','business','vip') then raise exception 'TENANT_PACKAGE_NOT_FOUND' using errcode='P0001'; end if;
  select is_enabled, value into v_policy_enabled, v_roles_policy from public.platform_settings where setting_key='owner_subaccount_roles';
  select value into v_limits_policy from public.platform_settings where setting_key='owner_subaccount_limits';
  select value into v_overrides_policy from public.platform_settings where setting_key='owner_limit_overrides';
  v_override := case when jsonb_typeof(v_overrides_policy->'overrides')='object' then v_overrides_policy->'overrides'->p_tenant_id::text else null end;

  if v_actor_role <> 'admin' then
    if v_policy_enabled=false then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if p_role='owner' then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if jsonb_typeof(v_roles_policy->'allowedRoles')='array' and not (v_roles_policy->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if jsonb_typeof(v_override->'allowedRoles')='array' and not (v_override->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
  end if;

  select * into v_platform_policy
  from public.powerhub_resolve_tenant_feature_policy(p_tenant_id, 'platform_users');

  if not coalesce(v_platform_policy.eligible, false)
     or not coalesce(v_platform_policy.enabled, false) then
    raise exception 'PLATFORM_USERS_FEATURE_DISABLED' using errcode='P0001';
  end if;

  if p_role = 'technician' then
    select * into v_field_policy
    from public.powerhub_resolve_tenant_feature_policy(p_tenant_id, 'field_users');

    if not coalesce(v_field_policy.eligible, false)
       or not coalesce(v_field_policy.enabled, false) then
      raise exception 'FIELD_USERS_FEATURE_DISABLED' using errcode='P0001';
    end if;
  end if;

  if not v_already_active_subaccount
     and v_platform_policy.effective_limit is not null then
    select count(*)::integer into v_current_count
    from public.tenant_members
    where tenant_id=p_tenant_id
      and role='member'
      and is_active=true
      and membership_status='active';

    if v_current_count >= v_platform_policy.effective_limit then
      raise exception 'SUBACCOUNT_LIMIT_REACHED' using errcode='P0001';
    end if;
  end if;

  insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,expires_at,invited_by_user_id)
    values(p_tenant_id,p_target_user_id,v_target_membership_role,true,'active',null,p_actor_user_id)
    on conflict (tenant_id,user_id) do update set role=excluded.role,is_active=true,membership_status='active',expires_at=null,updated_at=now();
  update public.staff_profiles set is_active=false,updated_at=now()
    where tenant_id=p_tenant_id and user_id=p_target_user_id
      and (site_id=p_site_id or (p_all_branches and site_id is null));
  insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active)
    values(p_tenant_id,v_target_site_id,p_target_user_id,p_role,true)
    on conflict (user_id,site_id,role) do update set is_active=true,updated_at=now()
    returning id into v_profile_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
    values(
      p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',v_profile_id::text,'assign_role',
      jsonb_build_object('membership',v_before_member,'profiles',v_before_profiles),
      jsonb_build_object('targetUserId',p_target_user_id,'role',p_role,'allBranches',p_all_branches,'assignedSiteId',v_target_site_id,'membershipRole',v_target_membership_role)
    );
  return query select v_profile_id,p_target_user_id;
end;
$$;

revoke execute on function public.powerhub_assign_existing_staff(bigint,bigint,bigint,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_assign_existing_staff(bigint,bigint,bigint,bigint,text,boolean) to service_role;
