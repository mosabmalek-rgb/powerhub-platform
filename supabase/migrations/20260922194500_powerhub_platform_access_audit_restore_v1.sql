-- Restore platform access security audit events with a stable, service-only contract.
-- Platform access is platform-scoped; tenantId is explicitly null for this event family.

create or replace function public.powerhub_admin_invite_platform_access(
  p_actor_user_id bigint,
  p_email text,
  p_platform_role text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns table (
  id bigint,
  email text,
  platform_role text,
  status text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_account_status text;
  v_id bigint;
begin
  select u.platform_role, u.account_status
    into v_actor_role, v_account_status
  from public.users u
  where u.id = p_actor_user_id
    and u.role = 'admin';

  if v_actor_role is null
     or v_actor_role <> 'platform_owner'
     or v_account_status <> 'active' then
    raise exception 'PLATFORM_OWNER_REQUIRED';
  end if;

  if p_platform_role not in ('platform_admin', 'finance_admin', 'platform_support') then
    raise exception 'INVALID_PLATFORM_ROLE';
  end if;

  if exists (
    select 1
    from public.users u
    where lower(u.email) = lower(trim(p_email))
      and (u.role = 'admin' or u.platform_role is not null)
  ) then
    raise exception 'ACCOUNT_ALREADY_EXISTS';
  end if;

  if exists (
    select 1
    from public.platform_access_invitations i
    where lower(i.email) = lower(trim(p_email))
      and i.status = 'invited'
      and i.expires_at > pg_catalog.now()
  ) then
    raise exception 'DUPLICATE_INVITATION';
  end if;

  insert into public.platform_access_invitations (
    email,
    platform_role,
    token_hash,
    status,
    invited_by_user_id,
    expires_at
  )
  values (
    lower(trim(p_email)),
    p_platform_role,
    p_token_hash,
    'invited',
    p_actor_user_id,
    p_expires_at
  )
  returning id into v_id;

  insert into public.platform_security_events (
    event_type,
    severity,
    status,
    title,
    created_by_user_id,
    related_user_id,
    metadata
  )
  values (
    'security_change',
    'info',
    'success',
    'دعوة وصول لإدارة المنصة',
    p_actor_user_id,
    null,
    jsonb_build_object(
      'event', 'platform_access_invited',
      'scope', 'platform',
      'tenantId', null,
      'actorUserId', p_actor_user_id,
      'invitationId', v_id,
      'email', lower(trim(p_email)),
      'platformRole', p_platform_role,
      'expiresAt', p_expires_at,
      'occurredAt', pg_catalog.now()
    )
  );

  return query
    select i.id, i.email, i.platform_role, i.status, i.expires_at
    from public.platform_access_invitations i
    where i.id = v_id;
end;
$$;

-- PostgreSQL cannot rename input parameter names with CREATE OR REPLACE.
-- Remove only the same-signature legacy variant so the canonical p_user_id
-- contract used by the adapter is deterministic across environments.
drop function if exists public.powerhub_admin_set_platform_access_role(bigint, bigint, text);

create or replace function public.powerhub_admin_set_platform_access_role(
  p_actor_user_id bigint,
  p_user_id bigint,
  p_platform_role text
)
returns table (
  success boolean,
  platform_role text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_actor_status text;
  v_target_role text;
  v_target_platform_role text;
begin
  select u.platform_role, u.account_status
    into v_actor_role, v_actor_status
  from public.users u
  where u.id = p_actor_user_id
    and u.role = 'admin';

  if v_actor_role is null
     or v_actor_role <> 'platform_owner'
     or v_actor_status <> 'active' then
    raise exception 'PLATFORM_OWNER_REQUIRED';
  end if;

  if p_user_id = p_actor_user_id then
    raise exception 'SELF_ROLE_CHANGE';
  end if;

  if p_platform_role not in ('platform_admin', 'finance_admin', 'platform_support') then
    raise exception 'INVALID_PLATFORM_ROLE';
  end if;

  select u.role, u.platform_role
    into v_target_role, v_target_platform_role
  from public.users u
  where u.id = p_user_id;

  if v_target_role is distinct from 'admin' then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  if v_target_platform_role = 'platform_owner' then
    raise exception 'PLATFORM_OWNER_PROTECTED';
  end if;

  update public.users
    set platform_role = p_platform_role,
        account_status = 'active',
        updated_at = pg_catalog.now()
  where id = p_user_id;

  insert into public.platform_security_events (
    event_type,
    severity,
    status,
    title,
    created_by_user_id,
    related_user_id,
    metadata
  )
  values (
    'security_change',
    'warning',
    'success',
    'تغيير دور منصة',
    p_actor_user_id,
    p_user_id,
    jsonb_build_object(
      'event', 'platform_role_changed',
      'scope', 'platform',
      'tenantId', null,
      'actorUserId', p_actor_user_id,
      'targetUserId', p_user_id,
      'oldRole', v_target_platform_role,
      'newRole', p_platform_role,
      'occurredAt', pg_catalog.now()
    )
  );

  return query
    select true, p_platform_role;
end;
$$;

revoke all on function public.powerhub_admin_invite_platform_access(
  bigint, text, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.powerhub_admin_invite_platform_access(
  bigint, text, text, text, timestamptz
) to service_role;

revoke all on function public.powerhub_admin_set_platform_access_role(
  bigint, bigint, text
) from public, anon, authenticated;

grant execute on function public.powerhub_admin_set_platform_access_role(
  bigint, bigint, text
) to service_role;
