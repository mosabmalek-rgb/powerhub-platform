-- PowerHub: membership/staff lifecycle integrity reconciliation
-- Keeps tenant membership state authoritative over all staff profiles and
-- prevents revoking/suspending the last active tenant owner.

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
  select u.platform_role
    into v_actor_platform_role
    from public.users u
   where u.id = p_actor_user_id
     and u.role = 'admin'
     and u.account_status = 'active';

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode = '42501';
  end if;

  if p_status not in ('active', 'suspended', 'revoked') then
    raise exception 'INVALID_MEMBERSHIP_STATUS' using errcode = '22023';
  end if;

  select tm.*
    into v_membership
    from public.tenant_members tm
   where tm.tenant_id = p_tenant_id
     and tm.user_id = p_user_id
   limit 1;

  select s.id
    into v_site_id
    from public.sites s
   where s.tenant_id = p_tenant_id
   order by s.id
   limit 1;

  if v_membership.id is null or v_site_id is null then
    raise exception 'MEMBERSHIP_OR_SITE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_membership.role = 'owner' and p_status <> 'active' then
    select count(*)::integer
      into v_active_owner_count
      from public.tenant_members tm
     where tm.tenant_id = p_tenant_id
       and tm.role = 'owner'
       and tm.is_active = true
       and tm.membership_status = 'active'
       and tm.user_id <> p_user_id;

    if v_active_owner_count = 0 then
      raise exception 'LAST_ACTIVE_OWNER_PROTECTED' using errcode = 'P0001';
    end if;
  end if;

  v_is_active := p_status = 'active';

  update public.tenant_members
     set membership_status = p_status,
         is_active = v_is_active,
         expires_at = case when p_status = 'revoked' then now() else null end,
         updated_at = now()
   where id = v_membership.id;

  -- Membership is the tenant-level source of truth. Synchronize every
  -- staff profile for this user in this tenant, not only the first site.
  update public.staff_profiles
     set is_active = v_is_active,
         updated_at = now()
   where tenant_id = p_tenant_id
     and user_id = p_user_id;

  insert into public.audit_logs(
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, before_data, after_data
  ) values (
    p_tenant_id,
    v_site_id,
    p_actor_user_id,
    v_actor_platform_role,
    'tenant_membership',
    v_membership.id::text,
    'platform_admin_set_tenant_membership_status',
    jsonb_build_object(
      'status', v_membership.membership_status,
      'isActive', v_membership.is_active
    ),
    jsonb_build_object(
      'status', p_status,
      'isActive', v_is_active,
      'staffProfilesSynchronized', true
    )
  );

  return query select true, v_membership.id, v_site_id, p_status;
end;
$$;

revoke execute on function public.powerhub_admin_set_tenant_membership_status(bigint,bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_set_tenant_membership_status(bigint,bigint,bigint,text) to service_role;
