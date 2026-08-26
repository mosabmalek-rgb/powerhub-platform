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
returns table (profile_id bigint, is_active boolean, suspension_ends_at timestamptz)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_before jsonb;
  v_target_user_id bigint;
  v_profile_active boolean;
  v_suspension_end timestamptz;
  v_actor_role text;
  v_actor_platform_role text;
  v_actor_tenant_role text;
  v_audit_action text;
  v_after jsonb;
begin
  if p_operation not in ('suspend','clear_suspension','set_active') then raise exception 'INVALID_STAFF_STATUS_OPERATION' using errcode='P0001'; end if;
  if not exists (select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select role,platform_role into v_actor_role,v_actor_platform_role from public.users where id=p_actor_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  if v_actor_role <> 'admin' then
    select role into v_actor_tenant_role from public.tenant_members where tenant_id=p_tenant_id and user_id=p_actor_user_id and is_active=true and membership_status='active';
    if v_actor_tenant_role <> 'owner' then raise exception 'STAFF_STATUS_MANAGEMENT_FORBIDDEN' using errcode='P0001'; end if;
  else
    v_actor_tenant_role:='platform_admin';
  end if;
  if p_operation='suspend' and (p_suspension_started_at is null or p_suspension_ends_at is null or p_suspension_ends_at<=p_suspension_started_at) then
    raise exception 'INVALID_SUSPENSION_WINDOW' using errcode='P0001';
  end if;
  if p_operation='set_active' and p_is_active is null then raise exception 'MISSING_ACTIVE_STATE' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(p_tenant_id,hashtext('staff-profile-status'));
  select to_jsonb(profile),profile.user_id,profile.is_active,profile.suspension_ends_at into v_before,v_target_user_id,v_profile_active,v_suspension_end
    from public.staff_profiles profile where profile.id=p_profile_id and profile.tenant_id=p_tenant_id and (profile.site_id=p_site_id or profile.site_id is null) for update;
  if not found then raise exception 'STAFF_PROFILE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  if p_operation='suspend' then
    update public.staff_profiles set suspension_started_at=p_suspension_started_at,suspension_ends_at=p_suspension_ends_at,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
    v_audit_action:='suspend_until';
    v_after:=jsonb_build_object('targetUserId',v_target_user_id,'suspensionStartedAt',p_suspension_started_at,'suspensionEndsAt',p_suspension_ends_at);
    v_suspension_end:=p_suspension_ends_at;
  elsif p_operation='clear_suspension' then
    update public.staff_profiles set suspension_started_at=null,suspension_ends_at=null,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
    v_audit_action:='clear_suspension';
    v_after:=jsonb_build_object('targetUserId',v_target_user_id);
    v_suspension_end:=null;
  else
    update public.staff_profiles set is_active=p_is_active,updated_at=now() where id=p_profile_id and tenant_id=p_tenant_id;
    v_audit_action:=case when p_is_active then 'activate' else 'deactivate' end;
    v_after:=jsonb_build_object('isActive',p_is_active,'userId',v_target_user_id);
    v_profile_active:=p_is_active;
  end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,actor_tenant_role,entity_type,entity_id,action,before_data,after_data)
    values(p_tenant_id,p_site_id,p_actor_user_id,v_actor_platform_role,v_actor_tenant_role,'staff_profile',p_profile_id::text,v_audit_action,v_before,v_after);
  return query select p_profile_id,v_profile_active,v_suspension_end;
end;
$$;

revoke execute on function public.powerhub_update_staff_profile_status(bigint,bigint,bigint,bigint,text,timestamptz,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_update_staff_profile_status(bigint,bigint,bigint,bigint,text,timestamptz,timestamptz,boolean) to service_role;
