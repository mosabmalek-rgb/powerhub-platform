-- PowerHub: reconcile the platform_support role with the current Production RPC contracts.
-- This migration intentionally preserves the newer idempotency parameters and return
-- columns already present in Production; it does not replay the older role migration.

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
  drop constraint if exists platform_capability_policies_platform_role_check;
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

create or replace function public.powerhub_admin_invite_platform_access(
  p_actor_user_id bigint,
  p_email text,
  p_platform_role text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_client_operation_id text,
  p_request_fingerprint text
)
returns table (
  id bigint,
  email text,
  platform_role text,
  status text,
  expires_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_account_status text;
  v_id bigint;
  v_existing public.platform_access_invitations%rowtype;
begin
  if nullif(trim(p_client_operation_id), '') is null then raise exception 'INVALID_OPERATION_ID'; end if;
  if nullif(trim(p_request_fingerprint), '') is null then raise exception 'INVALID_REQUEST_FINGERPRINT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-access-invite:' || trim(p_client_operation_id), 0));
  perform pg_advisory_xact_lock(hashtextextended('platform-access-invite-email:' || lower(trim(p_email)), 0));

  select u.platform_role, u.account_status
    into v_role, v_account_status
  from public.users u
  where u.id = p_actor_user_id and u.role = 'admin';
  if v_role is null or v_role <> 'platform_owner' or v_account_status <> 'active' then
    raise exception 'PLATFORM_OWNER_REQUIRED';
  end if;
  if p_platform_role not in ('platform_admin', 'finance_admin', 'platform_support') then
    raise exception 'INVALID_PLATFORM_ROLE';
  end if;

  select i.* into v_existing
  from public.platform_access_invitations i
  where i.client_operation_id = trim(p_client_operation_id)
  limit 1 for update;
  if found then
    if v_existing.request_fingerprint is distinct from p_request_fingerprint
       or lower(v_existing.email) is distinct from lower(trim(p_email))
       or v_existing.platform_role is distinct from p_platform_role
       or v_existing.invited_by_user_id is distinct from p_actor_user_id then
      raise exception 'OPERATION_CONFLICT';
    end if;
    return query select v_existing.id, v_existing.email, v_existing.platform_role,
      v_existing.status, v_existing.expires_at, true;
    return;
  end if;

  if exists (
    select 1 from public.platform_access_invitations i
    where lower(i.email) = lower(trim(p_email))
      and i.status = 'invited'
      and i.expires_at > now()
  ) then raise exception 'DUPLICATE_INVITATION'; end if;

  insert into public.platform_access_invitations(
    email, platform_role, token_hash, status, invited_by_user_id, expires_at,
    client_operation_id, request_fingerprint
  ) values (
    lower(trim(p_email)), p_platform_role, p_token_hash, 'invited', p_actor_user_id,
    p_expires_at, trim(p_client_operation_id), p_request_fingerprint
  ) returning platform_access_invitations.id into v_id;

  insert into public.platform_security_events(
    event_type, severity, status, title, created_by_user_id, metadata
  ) values (
    'security_change', 'info', 'success', 'دعوة وصول لإدارة المنصة', p_actor_user_id,
    jsonb_build_object(
      'invitationId', v_id,
      'email', lower(trim(p_email)),
      'platformRole', p_platform_role,
      'expiresAt', p_expires_at,
      'clientOperationId', trim(p_client_operation_id)
    )
  );

  return query
    select i.id, i.email, i.platform_role, i.status, i.expires_at, false
    from public.platform_access_invitations i
    where i.id = v_id;
end;
$$;

create or replace function public.powerhub_admin_set_platform_access_role(
  p_actor_user_id bigint,
  p_user_id bigint,
  p_platform_role text
)
returns table(success boolean, platform_role text, replayed boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_target public.users%rowtype;
begin
  if p_platform_role not in ('platform_admin', 'finance_admin', 'platform_support') then
    raise exception 'INVALID_PLATFORM_ROLE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('platform-role:' || p_user_id::text, 0));
  select * into v_actor
  from public.users
  where id = p_actor_user_id
    and role = 'admin'
    and platform_role = 'platform_owner'
    and account_status = 'active'
  for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  if p_user_id = p_actor_user_id then raise exception 'SELF_ROLE_CHANGE'; end if;

  select * into v_target from public.users where id = p_user_id and role = 'admin' for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if v_target.platform_role = 'platform_owner' then raise exception 'PLATFORM_OWNER_PROTECTED'; end if;
  if v_target.platform_role = p_platform_role and v_target.account_status = 'active' then
    return query select true, p_platform_role, true;
    return;
  end if;

  update public.users
    set platform_role = p_platform_role, account_status = 'active', updated_at = now()
  where id = v_target.id;

  insert into public.platform_security_events(
    event_type, severity, status, title, metadata, related_user_id,
    created_by_user_id, created_at, updated_at
  ) values (
    'security_change', 'info', 'success', 'تغيير دور حساب منصة',
    jsonb_build_object(
      'before', v_target.platform_role,
      'after', p_platform_role,
      'beforeAccountStatus', v_target.account_status,
      'afterAccountStatus', 'active',
      'actorPlatformRole', v_actor.platform_role
    ), v_target.id, v_actor.id, now(), now()
  );

  return query select true, p_platform_role, false;
end;
$$;

revoke all on function public.powerhub_admin_invite_platform_access(bigint, text, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_invite_platform_access(bigint, text, text, text, timestamptz, text, text) to service_role;
revoke all on function public.powerhub_admin_set_platform_access_role(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.powerhub_admin_set_platform_access_role(bigint, bigint, text) to service_role;

insert into private.platform_capability_policies(platform_role, capability, is_allowed, updated_at)
values ('platform_support', 'manageSupportChat', true, now())
on conflict (platform_role, capability)
do update set is_allowed = true, updated_at = now();

comment on function private.powerhub_has_platform_capability(text) is
  'Explicit platform capability resolver. Identity is derived from auth.uid(); platform_support is valid only when an explicit capability policy grants access.';

comment on function public.powerhub_admin_invite_platform_access(bigint, text, text, text, timestamptz, text, text) is
  'Service-role-only idempotent platform access invitation RPC; supports platform_support without weakening owner authorization.';

comment on function public.powerhub_admin_set_platform_access_role(bigint, bigint, text) is
  'Service-role-only idempotent platform role assignment RPC; supports platform_support without weakening owner authorization.';
