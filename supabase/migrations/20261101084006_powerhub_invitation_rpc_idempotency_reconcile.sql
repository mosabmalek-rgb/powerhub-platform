-- PowerHub: unify access-invitation idempotency across Production and Staging.
-- Forward-only reconciliation. Existing invitation rows are retained; nullable
-- operation metadata keeps historical rows valid while new requests are keyed.

alter table public.platform_access_invitations
  add column if not exists client_operation_id text,
  add column if not exists request_fingerprint text;

alter table public.access_invitations
  add column if not exists client_operation_id text,
  add column if not exists request_fingerprint text;

create unique index if not exists platform_access_invitations_client_operation_id_uidx
  on public.platform_access_invitations(client_operation_id)
  where client_operation_id is not null;

create unique index if not exists access_invitations_client_operation_id_uidx
  on public.access_invitations(client_operation_id)
  where client_operation_id is not null;

create index if not exists access_invitations_tenant_email_status_idx
  on public.access_invitations(tenant_id, lower(email), status);

-- Remove legacy signatures so PostgREST sees one unambiguous invitation RPC.
drop function if exists public.powerhub_admin_invite_platform_access(
  bigint, text, text, text, timestamptz
);
drop function if exists public.powerhub_admin_invite_platform_access(
  bigint, text, text, integer
);
drop function if exists public.powerhub_admin_invite_tenant_access(
  bigint, bigint, bigint, text, text, text, text, timestamptz
);

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
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_actor_role text;
  v_account_status text;
  v_existing public.platform_access_invitations%rowtype;
  v_id bigint;
begin
  if nullif(trim(p_client_operation_id), '') is null
     or length(trim(p_client_operation_id)) > 128 then
    raise exception 'INVALID_OPERATION_ID';
  end if;
  if nullif(trim(p_request_fingerprint), '') is null
     or length(trim(p_request_fingerprint)) > 128 then
    raise exception 'INVALID_REQUEST_FINGERPRINT';
  end if;
  if v_email is null or v_email = '' or length(v_email) > 320
     or position('@' in v_email) < 2 then
    raise exception 'INVALID_EMAIL';
  end if;
  if p_platform_role is null
     or p_platform_role not in ('platform_admin', 'finance_admin', 'platform_support') then
    raise exception 'INVALID_PLATFORM_ROLE';
  end if;
  if nullif(trim(p_token_hash), '') is null or length(p_token_hash) > 128 then
    raise exception 'INVALID_TOKEN_HASH';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'INVALID_EXPIRY';
  end if;

  -- Acquire idempotency locks before row locks so concurrent retries
  -- serialize on the operation key rather than on the actor row.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('platform-access-invite:' || trim(p_client_operation_id), 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('platform-access-invite-email:' || v_email, 0)
  );

  select u.platform_role, u.account_status
    into v_actor_role, v_account_status
  from public.users u
  where u.id = p_actor_user_id
    and u.role = 'admin'
  for update;

  if v_actor_role is distinct from 'platform_owner'
     or v_account_status is distinct from 'active' then
    raise exception 'PLATFORM_OWNER_REQUIRED';
  end if;

  select i.*
    into v_existing
  from public.platform_access_invitations i
  where i.client_operation_id = trim(p_client_operation_id)
  limit 1
  for update;

  if found then
    if v_existing.request_fingerprint is distinct from p_request_fingerprint
       or lower(v_existing.email) is distinct from v_email
       or v_existing.platform_role is distinct from p_platform_role
       or v_existing.invited_by_user_id is distinct from p_actor_user_id then
      raise exception 'OPERATION_CONFLICT';
    end if;

    return query
      select v_existing.id, v_existing.email, v_existing.platform_role,
             v_existing.status, v_existing.expires_at, true;
    return;
  end if;

  -- Keep the older Staging protection that was missing from the Production
  -- idempotent body: never invite an email already attached to a platform account.
  if exists (
    select 1
    from public.users u
    where lower(u.email) = v_email
      and (u.role = 'admin' or u.platform_role is not null)
  ) then
    raise exception 'ACCOUNT_ALREADY_EXISTS';
  end if;

  update public.platform_access_invitations i
    set status = 'expired',
        updated_at = now()
  where lower(i.email) = v_email
    and i.status = 'invited'
    and i.expires_at <= now();

  if exists (
    select 1
    from public.platform_access_invitations i
    where lower(i.email) = v_email
      and i.status = 'invited'
      and i.expires_at > now()
  ) then
    raise exception 'DUPLICATE_INVITATION';
  end if;

  insert into public.platform_access_invitations (
    email, platform_role, token_hash, status, invited_by_user_id, expires_at,
    client_operation_id, request_fingerprint
  ) values (
    v_email, p_platform_role, p_token_hash, 'invited', p_actor_user_id, p_expires_at,
    trim(p_client_operation_id), p_request_fingerprint
  )
  returning public.platform_access_invitations.id into v_id;

  insert into public.platform_security_events (
    event_type, severity, status, title, created_by_user_id, metadata
  ) values (
    'security_change', 'info', 'success', 'دعوة وصول لإدارة المنصة', p_actor_user_id,
    jsonb_build_object(
      'event', 'platform_access_invited',
      'scope', 'platform',
      'tenantId', null,
      'invitationId', v_id,
      'email', v_email,
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

create or replace function public.powerhub_admin_invite_tenant_access(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_site_id bigint,
  p_email text,
  p_tenant_role text,
  p_site_role text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_client_operation_id text,
  p_request_fingerprint text
)
returns table (
  invitation_id bigint,
  email text,
  expires_at timestamptz,
  status text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_site_role text := p_site_role;
  v_actor_id bigint;
  v_existing public.access_invitations%rowtype;
  v_invitation_id bigint;
begin
  if nullif(trim(p_client_operation_id), '') is null
     or length(trim(p_client_operation_id)) > 128 then
    raise exception 'INVALID_OPERATION_ID';
  end if;
  if nullif(trim(p_request_fingerprint), '') is null
     or length(trim(p_request_fingerprint)) > 128 then
    raise exception 'INVALID_REQUEST_FINGERPRINT';
  end if;
  if p_tenant_id is null or p_tenant_id <= 0
     or not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'TENANT_NOT_FOUND';
  end if;
  if v_email is null or v_email = '' or length(v_email) > 320
     or position('@' in v_email) < 2 then
    raise exception 'INVALID_EMAIL';
  end if;
  if p_tenant_role is null or p_tenant_role not in ('owner', 'admin', 'member') then
    raise exception 'INVALID_TENANT_ROLE';
  end if;
  if p_site_role is not null
     and p_site_role not in ('owner', 'manager', 'accountant', 'collector', 'technician', 'viewer') then
    raise exception 'INVALID_SITE_ROLE';
  end if;
  if nullif(trim(p_token_hash), '') is null or length(p_token_hash) > 128 then
    raise exception 'INVALID_TOKEN_HASH';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'INVALID_EXPIRY';
  end if;

  if p_site_id is not null and not exists (
    select 1
    from public.sites s
    where s.id = p_site_id
      and s.tenant_id = p_tenant_id
  ) then
    raise exception 'SITE_NOT_FOUND';
  end if;

  if p_tenant_role = 'owner' then
    v_site_role := 'owner';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tenant-access-invite:' || trim(p_client_operation_id), 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'tenant-access-invite-email:' || p_tenant_id::text || ':' || v_email, 0
    )
  );

  -- As with platform invitations, take the per-operation lock before locking
  -- the actor row to make concurrent identical retries converge deterministically.
  select u.id
    into v_actor_id
  from public.users u
  where u.id = p_actor_user_id
    and u.role = 'admin'
    and u.account_status = 'active'
    and u.platform_role in ('platform_owner', 'platform_admin')
  for update;

  if not found then
    raise exception 'PLATFORM_ADMIN_REQUIRED';
  end if;

  select i.*
    into v_existing
  from public.access_invitations i
  where i.client_operation_id = trim(p_client_operation_id)
  limit 1
  for update;

  if found then
    if v_existing.request_fingerprint is distinct from p_request_fingerprint
       or v_existing.tenant_id is distinct from p_tenant_id
       or v_existing.site_id is distinct from p_site_id
       or lower(v_existing.email) is distinct from v_email
       or v_existing.tenant_role is distinct from p_tenant_role
       or v_existing.site_role is distinct from v_site_role
       or v_existing.invited_by_user_id is distinct from p_actor_user_id then
      raise exception 'OPERATION_CONFLICT';
    end if;

    return query
      select v_existing.id, v_existing.email, v_existing.expires_at, v_existing.status, true;
    return;
  end if;

  update public.access_invitations i
    set status = 'expired',
        updated_at = now()
  where i.tenant_id = p_tenant_id
    and lower(i.email) = v_email
    and i.status = 'invited'
    and i.expires_at <= now();

  if exists (
    select 1
    from public.access_invitations i
    where i.tenant_id = p_tenant_id
      and lower(i.email) = v_email
      and i.status = 'invited'
      and i.expires_at > now()
  ) then
    raise exception 'DUPLICATE_INVITATION';
  end if;

  insert into public.access_invitations (
    tenant_id, site_id, email, tenant_role, site_role, token_hash,
    status, invited_by_user_id, expires_at, client_operation_id, request_fingerprint
  ) values (
    p_tenant_id, p_site_id, v_email, p_tenant_role, v_site_role, p_token_hash,
    'invited', p_actor_user_id, p_expires_at,
    trim(p_client_operation_id), p_request_fingerprint
  )
  returning id into v_invitation_id;

  insert into public.platform_security_events (
    event_type, severity, status, title, details, metadata,
    related_user_id, created_by_user_id
  ) values (
    'security_change', 'info', 'success', 'دعوة وصول إلى المستأجر',
    'تم إنشاء دعوة وصول للمستأجر من خلال مسار Supabase الإداري.',
    jsonb_build_object(
      'tenantId', p_tenant_id,
      'siteId', p_site_id,
      'invitationId', v_invitation_id,
      'email', v_email,
      'tenantRole', p_tenant_role,
      'siteRole', v_site_role,
      'status', 'invited',
      'expiresAt', p_expires_at,
      'clientOperationId', trim(p_client_operation_id)
    ),
    null, p_actor_user_id
  );

  return query
    select i.id, i.email, i.expires_at, i.status, false
    from public.access_invitations i
    where i.id = v_invitation_id;
end;
$$;

revoke all on function public.powerhub_admin_invite_platform_access(
  bigint, text, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.powerhub_admin_invite_platform_access(
  bigint, text, text, text, timestamptz, text, text
) to service_role;

revoke all on function public.powerhub_admin_invite_tenant_access(
  bigint, bigint, bigint, text, text, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.powerhub_admin_invite_tenant_access(
  bigint, bigint, bigint, text, text, text, text, timestamptz, text, text
) to service_role;

comment on function public.powerhub_admin_invite_platform_access(
  bigint, text, text, text, timestamptz, text, text
) is 'Service-role-only idempotent platform invitation RPC. Preserves active owner checks and ACCOUNT_ALREADY_EXISTS protection.';
comment on function public.powerhub_admin_invite_tenant_access(
  bigint, bigint, bigint, text, text, text, text, timestamptz, text, text
) is 'Service-role-only idempotent tenant invitation RPC with tenant/site validation and operation replay protection.';

notify pgrst, 'reload schema';
