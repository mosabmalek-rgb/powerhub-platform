-- PowerHub: dedicated platform support operator role.
-- The role is platform-scoped and receives only manageSupportChat.
-- It must never become a generic platform-admin role.

alter table public.users
  drop constraint if exists users_platform_role_check;

alter table public.users
  add constraint users_platform_role_check
  check (platform_role in ('platform_owner', 'platform_admin', 'finance_admin', 'platform_support'));

alter table public.platform_access_invitations
  drop constraint if exists platform_access_invitations_platform_role_check;

alter table public.platform_access_invitations
  add constraint platform_access_invitations_platform_role_check
  check (platform_role in ('platform_owner', 'platform_admin', 'finance_admin', 'platform_support'));

alter table private.platform_capability_policies
  drop constraint if exists platform_capability_policies_role_check;

alter table private.platform_capability_policies
  add constraint platform_capability_policies_role_check
  check (platform_role in ('platform_owner', 'platform_admin', 'finance_admin', 'platform_support'));

create or replace function private.powerhub_has_platform_capability(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u
    join private.platform_capability_policies policy
      on policy.platform_role = u.platform_role
     and policy.capability = p_capability
     and policy.is_allowed = true
    where u.auth_user_id = auth.uid()
      and u.account_status = 'active'
      and u.platform_role in ('platform_owner', 'platform_admin', 'finance_admin', 'platform_support')
  );
$$;

comment on function private.powerhub_has_platform_capability(text) is
  'Explicit platform capability resolver. Identity is derived only from auth.uid(); platform_support is valid only when an explicit platform capability policy grants access.';

create or replace function public.powerhub_has_platform_capability(p_capability text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.powerhub_has_platform_capability(p_capability)
$$;

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
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_account_status text;
  v_id bigint;
begin
  select u.platform_role, u.account_status
    into v_actor_role, v_account_status
  from public.users u
  where u.id = p_actor_user_id and u.role = 'admin';

  if v_actor_role is null or v_actor_role <> 'platform_owner' or v_account_status <> 'active' then
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
      and i.expires_at > now()
  ) then
    raise exception 'DUPLICATE_INVITATION';
  end if;

  insert into public.platform_access_invitations (
    email, platform_role, token_hash, status, invited_by_user_id, expires_at
  ) values (
    lower(trim(p_email)), p_platform_role, p_token_hash, 'invited', p_actor_user_id, p_expires_at
  ) returning platform_access_invitations.id into v_id;

  insert into public.platform_security_events (
    event_type, severity, status, title, created_by_user_id, metadata
  ) values (
    'security_change', 'info', 'success', 'دعوة وصول لإدارة المنصة', p_actor_user_id,
    jsonb_build_object(
      'invitationId', v_id,
      'email', lower(trim(p_email)),
      'platformRole', p_platform_role,
      'expiresAt', p_expires_at
    )
  );

  return query
    select i.id, i.email, i.platform_role, i.status, i.expires_at
    from public.platform_access_invitations i
    where i.id = v_id;
end;
$$;

create or replace function public.powerhub_admin_set_platform_access_role(
  p_actor_user_id bigint,
  p_target_user_id bigint,
  p_platform_role text
)
returns table(success boolean, platform_role text)
language plpgsql
security definer
set search_path = public, pg_temp
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
  where u.id = p_actor_user_id and u.role = 'admin';

  if v_actor_role is null or v_actor_role <> 'platform_owner' or v_actor_status <> 'active' then
    raise exception 'PLATFORM_OWNER_REQUIRED';
  end if;

  if p_target_user_id = p_actor_user_id then
    raise exception 'SELF_ROLE_CHANGE';
  end if;

  if p_platform_role not in ('platform_admin', 'finance_admin', 'platform_support') then
    raise exception 'INVALID_PLATFORM_ROLE';
  end if;

  select u.role, u.platform_role
    into v_target_role, v_target_platform_role
  from public.users u
  where u.id = p_target_user_id;

  if v_target_role is distinct from 'admin' then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  if v_target_platform_role = 'platform_owner' then
    raise exception 'PLATFORM_OWNER_PROTECTED';
  end if;

  update public.users
    set platform_role = p_platform_role,
        account_status = 'active',
        updated_at = now()
  where id = p_target_user_id;

  insert into public.platform_security_events (
    event_type, severity, status, title, created_by_user_id, metadata
  ) values (
    'security_change', 'warning', 'success', 'تغيير دور منصة', p_actor_user_id,
    jsonb_build_object(
      'targetUserId', p_target_user_id,
      'before', v_target_platform_role,
      'after', p_platform_role
    )
  );

  return query
    select true, p_platform_role;
end;
$$;

revoke all on function public.powerhub_admin_invite_platform_access(bigint, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_admin_invite_platform_access(bigint, text, text, text, timestamptz) to service_role;

revoke all on function public.powerhub_admin_set_platform_access_role(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_set_platform_access_role(bigint, bigint, text) to service_role;

insert into private.platform_capability_policies (platform_role, capability, is_allowed, updated_at)
values ('platform_support', 'manageSupportChat', true, now())
on conflict (platform_role, capability)
do update set is_allowed = true, updated_at = now();

