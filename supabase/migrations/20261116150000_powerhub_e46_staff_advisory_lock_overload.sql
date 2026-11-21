-- E46: Fix unsupported pg_advisory_xact_lock(bigint, integer) in five
-- existing staff/team RPCs. PostgreSQL supports (bigint) or (integer,integer),
-- NOT (bigint,integer). Keep tenant-specific serialization using one 64-bit
-- hashtextextended key, preserving operation namespaces.
-- Source is copied from installed Staging function definitions with ONLY
-- the five advisory-lock expressions substituted; signatures and ACLs remain.
-- Migration must be applied via the controlled canonical Git migration pipeline.
-- Do not promote to Production without separate approval.

DO $e46_before$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('powerhub_assign_existing_staff','powerhub_delete_custom_permission_role','powerhub_staff_reset_password_begin','powerhub_update_staff_profile_permissions','powerhub_update_staff_profile_status')
      AND p.prosrc NOT LIKE '%pg_advisory_xact_lock(%'
  ) THEN RAISE EXCEPTION 'E46_STAFF_LOCK_SCHEMA_PRECONDITION_FAILED'; END IF;
END
$e46_before$;

CREATE OR REPLACE FUNCTION public.powerhub_assign_existing_staff(p_tenant_id bigint, p_site_id bigint, p_actor_user_id bigint, p_target_user_id bigint, p_role text, p_all_branches boolean)
 RETURNS TABLE(profile_id bigint, target_user_id bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text; v_existing_member_role text; v_existing_member_active boolean; v_existing_membership_status text; v_target_membership_role text; v_target_site_id bigint; v_plan text; v_policy_enabled boolean; v_roles_policy jsonb; v_limits_policy jsonb; v_overrides_policy jsonb; v_override jsonb; v_limit_text text; v_override_limit_text text; v_limit integer; v_current_count integer; v_already_active_subaccount boolean:=false; v_before_member jsonb; v_before_profiles jsonb; v_profile_id bigint;
begin
  if p_role not in ('owner','manager','accountant','collector','technician','viewer') then raise exception 'INVALID_STAFF_ROLE' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id; if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if not exists(select 1 from public.users where id=p_target_user_id) then raise exception 'TARGET_USER_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'STAFF_ASSIGNMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  perform pg_advisory_xact_lock(hashtextextended('powerhub:staff-assignment:' || p_tenant_id::text, 0));
  select to_jsonb(member),member.role,member.is_active,member.membership_status into v_before_member,v_existing_member_role,v_existing_member_active,v_existing_membership_status from public.tenant_members member where member.tenant_id=p_tenant_id and member.user_id=p_target_user_id for update;
  v_already_active_subaccount:=found and v_existing_member_role='member' and v_existing_member_active=true and v_existing_membership_status='active';
  v_target_membership_role:=case when found and v_existing_member_role='owner' then 'owner' else 'member' end;
  v_target_site_id:=case when p_all_branches then null else p_site_id end;
  select coalesce(jsonb_agg(to_jsonb(profile)),'[]'::jsonb) into v_before_profiles from public.staff_profiles profile where profile.tenant_id=p_tenant_id and profile.user_id=p_target_user_id and (profile.site_id=p_site_id or (p_all_branches and profile.site_id is null));
  select plan into v_plan from public.tenant_subscriptions where tenant_id=p_tenant_id; if v_plan is null then select plan into v_plan from public.tenants where id=p_tenant_id; end if; if v_plan not in ('starter','professional','enterprise') then raise exception 'TENANT_PLAN_NOT_FOUND' using errcode='P0001'; end if;
  select is_enabled,value into v_policy_enabled,v_roles_policy from public.platform_settings where setting_key='owner_subaccount_roles'; select value into v_limits_policy from public.platform_settings where setting_key='owner_subaccount_limits'; select value into v_overrides_policy from public.platform_settings where setting_key='owner_limit_overrides'; v_override:=case when jsonb_typeof(v_overrides_policy->'overrides')='object' then v_overrides_policy->'overrides'->p_tenant_id::text else null end;
  if v_actor_role<>'admin' then
    if v_policy_enabled=false then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if p_role='owner' then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if jsonb_typeof(v_roles_policy->'allowedRoles')='array' and not (v_roles_policy->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
    if jsonb_typeof(v_override->'allowedRoles')='array' and not (v_override->'allowedRoles' ? p_role) then raise exception 'SUBACCOUNT_ROLE_NOT_ALLOWED' using errcode='P0001'; end if;
  end if;
  v_limit:=case v_plan when 'starter' then 2 when 'professional' then 5 else 15 end; v_limit_text:=v_limits_policy->'limits'->>v_plan; if v_limit_text~'^\\d+$' and v_limit_text::integer between 0 and 999 then v_limit:=v_limit_text::integer; end if; v_override_limit_text:=v_override->>'subaccountLimit'; if v_override_limit_text~'^\\d+$' then v_limit:=v_override_limit_text::integer; end if;
  select count(*)::integer into v_current_count from public.tenant_members where tenant_id=p_tenant_id and role='member' and is_active=true and membership_status='active';
  if not v_already_active_subaccount and v_current_count>=v_limit then raise exception 'SUBACCOUNT_LIMIT_REACHED' using errcode='P0001'; end if;
  insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,expires_at,invited_by_user_id) values(p_tenant_id,p_target_user_id,v_target_membership_role,true,'active',null,p_actor_user_id) on conflict(tenant_id,user_id) do update set role=excluded.role,is_active=true,membership_status='active',expires_at=null,updated_at=now();
  update public.staff_profiles set is_active=false,updated_at=now() where tenant_id=p_tenant_id and user_id=p_target_user_id and (site_id=p_site_id or (p_all_branches and site_id is null));
  insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active) values(p_tenant_id,v_target_site_id,p_target_user_id,p_role,true) on conflict(user_id,site_id,role) do update set is_active=true,updated_at=now() returning id into v_profile_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',v_profile_id::text,'assign_role',jsonb_build_object('membership',v_before_member,'profiles',v_before_profiles),jsonb_build_object('targetUserId',p_target_user_id,'role',p_role,'allBranches',p_all_branches,'assignedSiteId',v_target_site_id,'membershipRole',v_target_membership_role));
  return query select v_profile_id,p_target_user_id;
end; $function$;

CREATE OR REPLACE FUNCTION public.powerhub_delete_custom_permission_role(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_role_id bigint)
 RETURNS TABLE(role_id bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_before jsonb; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
begin
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_user_id; if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'ROLE_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  perform pg_advisory_xact_lock(hashtextextended('powerhub:custom-permission-role:' || p_tenant_id::text, 0));
  select to_jsonb(role) into v_before from public.custom_permission_roles role where role.id=p_role_id and role.tenant_id=p_tenant_id for update; if not found then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.staff_profiles where tenant_id=p_tenant_id and custom_role_id=p_role_id and is_active=true for key share) then raise exception 'CUSTOM_ROLE_LINKED' using errcode='P0001'; end if;
  update public.custom_permission_roles set is_active=false,updated_at=now() where id=p_role_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,v_actor_tenant_role,'custom_permission_role',p_role_id::text,'delete',v_before,jsonb_build_object('isActive',false)); return query select p_role_id;
end; $function$;

CREATE OR REPLACE FUNCTION public.powerhub_staff_reset_password_begin(p_tenant_id bigint, p_site_id bigint, p_actor_user_id bigint, p_profile_id bigint)
 RETURNS TABLE(intent_id bigint, auth_user_id uuid, target_user_id bigint, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_role text;
  v_actor_platform_role text;
  v_actor_tenant_role text;
  v_target_user_id bigint;
  v_auth_user_id uuid;
  v_profile_role text;
  v_expires_at timestamptz;
  v_before jsonb;
begin
  if not exists (select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select role, platform_role into v_actor_role, v_actor_platform_role
  from public.users where id=p_actor_user_id and account_status='active';
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role='admin' then raise exception 'STAFF_PASSWORD_RESET_FORBIDDEN' using errcode='P0001'; end if;

  select role into v_actor_tenant_role
  from public.tenant_members
  where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active';
  if v_actor_tenant_role <> 'owner' then raise exception 'STAFF_PASSWORD_RESET_FORBIDDEN' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(hashtextextended('powerhub:staff-password-reset:' || p_tenant_id::text, 0));

  update public.staff_password_reset_intents
  set status='expired', failed_at=coalesce(failed_at,now()),
      metadata=metadata || jsonb_build_object('reason','expired_before_new_request')
  where tenant_id=p_tenant_id and status='pending' and expires_at<=now();

  if exists (
    select 1 from public.staff_password_reset_intents
    where tenant_id=p_tenant_id and target_profile_id=p_profile_id and status='pending'
  ) then
    raise exception 'RESET_ALREADY_PENDING' using errcode='P0001';
  end if;

  select profile.user_id, profile.role, to_jsonb(profile)
    into v_target_user_id, v_profile_role, v_before
  from public.staff_profiles profile
  where profile.id=p_profile_id and profile.tenant_id=p_tenant_id
    and (profile.site_id=p_site_id or profile.site_id is null)
    and profile.is_active=true
  for update;
  if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_profile_role='owner' then raise exception 'STAFF_PASSWORD_RESET_FORBIDDEN' using errcode='P0001'; end if;

  select auth_user_id into v_auth_user_id
  from public.users where id=v_target_user_id and account_status<>'disabled';
  if v_auth_user_id is null then raise exception 'STAFF_AUTH_USER_MISSING' using errcode='P0001'; end if;

  insert into public.staff_password_reset_intents(
    tenant_id,site_id,actor_user_id,target_profile_id,target_user_id,auth_user_id,status,expires_at
  )
  values (
    p_tenant_id,p_site_id,p_actor_user_id,p_profile_id,v_target_user_id,v_auth_user_id,'pending',now()+interval '15 minutes'
  )
  returning id, staff_password_reset_intents.expires_at into intent_id,v_expires_at;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,
    'staff_password_reset',intent_id::text,'request',v_before,
    jsonb_build_object('targetUserId',v_target_user_id,'targetProfileId',p_profile_id),
    jsonb_build_object('expiresAt',v_expires_at)
  );

  return query select intent_id,v_auth_user_id,v_target_user_id,v_expires_at;
end;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_update_staff_profile_permissions(p_tenant_id bigint, p_site_id bigint, p_actor_user_id bigint, p_profile_id bigint, p_custom_role_id bigint, p_permissions jsonb)
 RETURNS TABLE(profile_id bigint, target_user_id bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_before jsonb; v_target_user_id bigint; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text;
begin
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id; if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'STAFF_PERMISSION_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  if p_permissions is null or jsonb_typeof(p_permissions)<>'array' or jsonb_array_length(p_permissions)<1 then raise exception 'INVALID_STAFF_PERMISSIONS' using errcode='P0001'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_permissions) capability(value) where capability.value not in ('manageSubscribers','manageGenerators','recordReadings','accessFieldApp','approveReadings','manageTariffs','issueInvoices','collectPayments','manageExpenses','managePayroll','manageTeam','manageMessaging','viewAudit')) then raise exception 'INVALID_STAFF_PERMISSION_CAPABILITY' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('powerhub:staff-profile-permissions:' || p_tenant_id::text, 0));
  if p_custom_role_id is not null and not exists(select 1 from public.custom_permission_roles where id=p_custom_role_id and tenant_id=p_tenant_id and is_active=true for key share) then raise exception 'CUSTOM_ROLE_NOT_FOUND' using errcode='P0001'; end if;
  select to_jsonb(profile),profile.user_id into v_before,v_target_user_id from public.staff_profiles profile where profile.id=p_profile_id and profile.tenant_id=p_tenant_id and (profile.site_id=p_site_id or profile.site_id is null) for update; if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  update public.staff_profiles set custom_role_id=p_custom_role_id,permissions=p_permissions,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,'update_permissions',v_before,jsonb_build_object('customRoleId',p_custom_role_id,'permissions',p_permissions,'targetUserId',v_target_user_id)); return query select p_profile_id,v_target_user_id;
end; $function$;

CREATE OR REPLACE FUNCTION public.powerhub_update_staff_profile_status(p_tenant_id bigint, p_site_id bigint, p_actor_user_id bigint, p_profile_id bigint, p_operation text, p_suspension_started_at timestamp with time zone, p_suspension_ends_at timestamp with time zone, p_is_active boolean)
 RETURNS TABLE(profile_id bigint, is_active boolean, suspension_ends_at timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_before jsonb; v_target_user_id bigint; v_profile_active boolean; v_suspension_end timestamptz; v_actor_role text; v_actor_platform_role text; v_actor_tenant_role text; v_audit_action text; v_after jsonb;
begin
  if p_operation not in ('suspend','clear_suspension','set_active') then raise exception 'INVALID_STAFF_STATUS_OPERATION' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id; if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role<>'admin' then select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active'; if v_actor_tenant_role<>'owner' then raise exception 'STAFF_STATUS_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if; else v_actor_tenant_role:='platform_admin'; end if;
  if p_operation='suspend' and (p_suspension_started_at is null or p_suspension_ends_at is null or p_suspension_ends_at<=p_suspension_started_at) then raise exception 'INVALID_SUSPENSION_WINDOW' using errcode='P0001'; end if;
  if p_operation='set_active' and p_is_active is null then raise exception 'MISSING_ACTIVE_STATE' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('powerhub:staff-profile-status:' || p_tenant_id::text, 0));
  select to_jsonb(profile),profile.user_id,profile.is_active,profile.suspension_ends_at into v_before,v_target_user_id,v_profile_active,v_suspension_end from public.staff_profiles profile where profile.id=p_profile_id and profile.tenant_id=p_tenant_id and (profile.site_id=p_site_id or profile.site_id is null) for update; if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if p_operation='suspend' then update public.staff_profiles set suspension_started_at=p_suspension_started_at,suspension_ends_at=p_suspension_ends_at,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id; v_audit_action:='suspend_until'; v_after:=jsonb_build_object('targetUserId',v_target_user_id,'suspensionStartedAt',p_suspension_started_at,'suspensionEndsAt',p_suspension_ends_at); v_suspension_end:=p_suspension_ends_at;
  elsif p_operation='clear_suspension' then update public.staff_profiles set suspension_started_at=null,suspension_ends_at=null,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id; v_audit_action:='clear_suspension'; v_after:=jsonb_build_object('targetUserId',v_target_user_id); v_suspension_end:=null;
  else update public.staff_profiles set is_active=p_is_active,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id; v_audit_action:=case when p_is_active then 'activate' else 'deactivate' end; v_after:=jsonb_build_object('isActive',p_is_active,'userId',v_target_user_id); v_profile_active:=p_is_active; end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,v_audit_action,v_before,v_after);
  return query select p_profile_id,v_profile_active,v_suspension_end;
end; $function$;

-- Read-only post-deployment inspection: all five must use supported bigint
-- lock overload, with no anonymous or authenticated EXECUTE grant.
DO $e46_after$
DECLARE c int;
BEGIN
  SELECT count(*) INTO c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN
    ('powerhub_assign_existing_staff','powerhub_delete_custom_permission_role','powerhub_staff_reset_password_begin','powerhub_update_staff_profile_permissions','powerhub_update_staff_profile_status')
    AND p.prosrc LIKE '%pg_advisory_xact_lock(hashtextextended(%'
    AND p.prosrc NOT LIKE '%pg_advisory_xact_lock(p_tenant_id,%'
    AND has_function_privilege('service_role',p.oid,'EXECUTE')
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE');
  IF c<>5 THEN RAISE EXCEPTION 'E46_STAFF_LOCK_OR_EXECUTE_GUARD_FAILED_%',c; END IF;
END
$e46_after$;
