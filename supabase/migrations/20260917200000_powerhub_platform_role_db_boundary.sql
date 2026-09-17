-- PowerHub: defense-in-depth platform-role validation in privileged lifecycle RPCs.
-- The application layer already requires an active platform identity. These
-- database checks keep the same authorization contract at the RPC boundary.

create or replace function public.powerhub_admin_set_tenant_membership_status(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_status text
)
returns table(success boolean, membership_id bigint, site_id bigint, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_membership public.tenant_members%rowtype;
  v_site_id bigint;
  v_is_active boolean;
  v_active_owner_count integer;
begin
  select u.platform_role into v_actor_platform_role
  from public.users u
  where u.id=p_actor_user_id
    and u.role='admin'
    and u.account_status='active'
    and u.platform_role in ('platform_owner','platform_admin','finance_admin');
  if v_actor_platform_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
  if p_status not in ('active','suspended','revoked') then raise exception 'INVALID_MEMBERSHIP_STATUS' using errcode='22023'; end if;
  select tm.* into v_membership from public.tenant_members tm where tm.tenant_id=p_tenant_id and tm.user_id=p_user_id limit 1;
  select s.id into v_site_id from public.sites s where s.tenant_id=p_tenant_id order by s.id limit 1;
  if v_membership.id is null or v_site_id is null then raise exception 'MEMBERSHIP_OR_SITE_NOT_FOUND' using errcode='P0002'; end if;
  if v_membership.role='owner' and p_status<>'active' then
    select count(*)::integer into v_active_owner_count from public.tenant_members tm where tm.tenant_id=p_tenant_id and tm.role='owner' and tm.is_active=true and tm.membership_status='active' and tm.user_id<>p_user_id;
    if v_active_owner_count=0 then raise exception 'LAST_ACTIVE_OWNER_PROTECTED' using errcode='P0001'; end if;
  end if;
  v_is_active := p_status='active';
  update public.tenant_members set membership_status=p_status,is_active=v_is_active,expires_at=case when p_status='revoked' then now() else null end,updated_at=now() where id=v_membership.id;
  update public.staff_profiles set is_active=v_is_active,updated_at=now() where tenant_id=p_tenant_id and user_id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,'tenant_membership',v_membership.id::text,'platform_admin_set_tenant_membership_status',jsonb_build_object('status',v_membership.membership_status,'isActive',v_membership.is_active),jsonb_build_object('status',p_status,'isActive',v_is_active,'staffProfilesSynchronized',true));
  return query select true,v_membership.id,v_site_id,p_status;
end;
$$;

revoke execute on function public.powerhub_admin_set_tenant_membership_status(bigint,bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_set_tenant_membership_status(bigint,bigint,bigint,text) to service_role;

create or replace function public.powerhub_update_staff_profile_status(
  p_tenant_id bigint,
  p_site_id bigint,
  p_actor_user_id bigint,
  p_profile_id bigint,
  p_operation text,
  p_suspension_started_at timestamptz,
  p_suspension_ends_at timestamptz,
  p_is_active boolean
)
returns table(profile_id bigint, is_active boolean, suspension_ends_at timestamptz)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_target_user_id bigint;
  v_target_tenant_role text;
  v_profile_active boolean;
  v_suspension_end timestamptz;
  v_actor_role text;
  v_actor_platform_role text;
  v_actor_tenant_role text;
  v_audit_action text;
  v_after jsonb;
begin
  if p_operation not in ('suspend', 'clear_suspension', 'set_active') then raise exception 'INVALID_STAFF_STATUS_OPERATION' using errcode='P0001'; end if;
  if not exists (select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role, platform_role into v_actor_role, v_actor_platform_role from public.users where id=p_actor_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role <> 'admin' then
    select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active';
    if v_actor_tenant_role <> 'owner' then raise exception 'STAFF_STATUS_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if;
  else
    if not exists (select 1 from public.users u where u.id=p_actor_user_id and u.account_status='active' and u.platform_role in ('platform_owner','platform_admin','finance_admin')) then
      raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
    end if;
    v_actor_tenant_role := 'platform_admin';
  end if;
  if p_operation='suspend' and (p_suspension_started_at is null or p_suspension_ends_at is null or p_suspension_ends_at<=p_suspension_started_at) then raise exception 'INVALID_SUSPENSION_WINDOW' using errcode='P0001'; end if;
  if p_operation='set_active' and p_is_active is null then raise exception 'MISSING_ACTIVE_STATE' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('staff-profile-status'));
  select to_jsonb(profile),profile.user_id,profile.is_active,profile.suspension_ends_at into v_before,v_target_user_id,v_profile_active,v_suspension_end from public.staff_profiles profile where profile.id=p_profile_id and profile.tenant_id=p_tenant_id and (profile.site_id=p_site_id or profile.site_id is null) for update;
  if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role into v_target_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=v_target_user_id and is_active=true and membership_status='active';
  if v_target_tenant_role='owner' then raise exception 'OWNER_PROFILE_PROTECTED' using errcode='P0001'; end if;
  if v_target_user_id=p_actor_user_id then raise exception 'SELF_STAFF_STATUS_CHANGE_FORBIDDEN' using errcode='P0001'; end if;
  if p_operation='suspend' then
    update public.staff_profiles set suspension_started_at=p_suspension_started_at,suspension_ends_at=p_suspension_ends_at,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
    v_audit_action:='suspend_until'; v_after:=jsonb_build_object('targetUserId',v_target_user_id,'suspensionStartedAt',p_suspension_started_at,'suspensionEndsAt',p_suspension_ends_at); v_suspension_end:=p_suspension_ends_at;
  elsif p_operation='clear_suspension' then
    update public.staff_profiles set suspension_started_at=null,suspension_ends_at=null,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
    v_audit_action:='clear_suspension'; v_after:=jsonb_build_object('targetUserId',v_target_user_id); v_suspension_end:=null;
  else
    update public.staff_profiles set is_active=p_is_active,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
    v_audit_action:=case when p_is_active then 'activate' else 'deactivate' end; v_after:=jsonb_build_object('isActive',p_is_active,'userId',v_target_user_id); v_profile_active:=p_is_active;
  end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,v_audit_action,v_before,v_after);
  return query select p_profile_id,v_profile_active,v_suspension_end;
end;
$$;

revoke all on function public.powerhub_update_staff_profile_status(bigint,bigint,bigint,bigint,text,timestamptz,timestamptz,boolean) from public, anon, authenticated;
grant execute on function public.powerhub_update_staff_profile_status(bigint,bigint,bigint,bigint,text,timestamptz,timestamptz,boolean) to service_role;
