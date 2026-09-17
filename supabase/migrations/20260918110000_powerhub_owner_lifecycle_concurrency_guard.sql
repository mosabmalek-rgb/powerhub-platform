-- PowerHub: serialize tenant-owner lifecycle mutations.
-- The last-active-owner check must be atomic with the membership update, and
-- owner attachment must use the same lock so transfer/status operations cannot
-- interleave into an invalid owner state.

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
     and u.account_status = 'active'
     and u.platform_role in ('platform_owner','platform_admin','finance_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode = '42501';
  end if;

  if p_status not in ('active','suspended','revoked') then
    raise exception 'INVALID_MEMBERSHIP_STATUS' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('tenant-owner-lifecycle:' || p_tenant_id::text)::bigint
  );

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

revoke all on function public.powerhub_admin_set_tenant_membership_status(bigint,bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_set_tenant_membership_status(bigint,bigint,bigint,text) to service_role;

create or replace function public.powerhub_admin_attach_owner_user(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_site_id bigint default null
)
returns table(success boolean, site_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_user_role text;
  v_user_platform_role text;
  v_user_account_status text;
  v_site_id bigint;
  v_previous_owners jsonb;
begin
  select u.platform_role
    into v_actor_platform_role
    from public.users u
   where u.id = p_actor_user_id
     and u.role = 'admin'
     and u.account_status = 'active'
     and u.platform_role in ('platform_owner','platform_admin','finance_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode = '42501';
  end if;

  select u.role, u.platform_role, u.account_status
    into v_user_role, v_user_platform_role, v_user_account_status
    from public.users u
   where u.id = p_user_id;

  if v_user_role is null then
    raise exception 'OWNER_USER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_user_role <> 'user' or v_user_platform_role is not null then
    raise exception 'PLATFORM_ACCOUNT_CANNOT_BE_OWNER' using errcode = '42501';
  end if;

  if v_user_account_status <> 'active' then
    raise exception 'OWNER_USER_NOT_ACTIVE' using errcode = '42501';
  end if;

  if p_site_id is not null then
    select s.id into v_site_id
      from public.sites s
     where s.id = p_site_id
       and s.tenant_id = p_tenant_id;
  else
    select s.id into v_site_id
      from public.sites s
     where s.tenant_id = p_tenant_id
     order by s.id
     limit 1;
  end if;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('tenant-owner-lifecycle:' || p_tenant_id::text)::bigint
  );

  select coalesce(
    jsonb_agg(jsonb_build_object('userId', tm.user_id, 'membershipId', tm.id)),
    '[]'::jsonb
  )
    into v_previous_owners
    from public.tenant_members tm
   where tm.tenant_id = p_tenant_id
     and tm.role = 'owner'
     and tm.user_id <> p_user_id;

  update public.tenant_members
     set role = 'member',
         updated_at = now()
   where tenant_id = p_tenant_id
     and role = 'owner'
     and user_id <> p_user_id;

  update public.staff_profiles
     set is_active = false,
         updated_at = now()
   where tenant_id = p_tenant_id
     and user_id <> p_user_id
     and role = 'owner';

  insert into public.tenant_members(
    tenant_id,
    user_id,
    role,
    is_active,
    membership_status,
    updated_at
  ) values (
    p_tenant_id,
    p_user_id,
    'owner',
    true,
    'active',
    now()
  )
  on conflict (tenant_id, user_id)
  do update set
    role = 'owner',
    is_active = true,
    membership_status = 'active',
    expires_at = null,
    updated_at = now();

  insert into public.staff_profiles(
    tenant_id,
    site_id,
    user_id,
    role,
    is_active,
    updated_at
  ) values (
    p_tenant_id,
    v_site_id,
    p_user_id,
    'owner',
    true,
    now()
  )
  on conflict (user_id, site_id, role)
  do update set
    is_active = true,
    updated_at = now();

  update public.tenant_owner_profiles
     set owner_user_id = p_user_id,
         claimed_at = now(),
         updated_at = now()
   where tenant_id = p_tenant_id;

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    metadata
  ) values (
    p_tenant_id,
    v_site_id,
    p_actor_user_id,
    v_actor_platform_role,
    'tenant_owner_profile',
    p_tenant_id::text,
    'platform_admin_attach_owner_user',
    jsonb_build_object(
      'attachedUserId', p_user_id,
      'previousOwners', v_previous_owners,
      'ownershipTransferred', true
    )
  );

  return query select true, v_site_id;
end;
$$;

revoke execute on function public.powerhub_admin_attach_owner_user(bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_admin_attach_owner_user(bigint,bigint,bigint,bigint) to service_role;
