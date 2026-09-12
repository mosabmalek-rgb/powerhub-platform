create or replace function public.powerhub_admin_invite_tenant_access(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_site_id bigint,
  p_email text,
  p_tenant_role text,
  p_site_role text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns table (invitation_id bigint, email text, expires_at timestamptz, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_site_id bigint := p_site_id;
  v_site_role text := p_site_role;
  v_invitation_id bigint;
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_user_id
      and role = 'admin'
      and account_status = 'active'
      and platform_role in ('platform_owner', 'platform_admin')
  ) then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = 'P0001';
  end if;

  if p_tenant_id is null or p_tenant_id <= 0 then
    raise exception 'INVALID_TENANT_ID' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'TENANT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if nullif(trim(p_email), '') is null or length(trim(p_email)) > 320 then
    raise exception 'INVALID_EMAIL' using errcode = 'P0001';
  end if;
  if p_tenant_role not in ('owner', 'admin', 'member') then
    raise exception 'INVALID_TENANT_ROLE' using errcode = 'P0001';
  end if;
  if p_site_role is not null and p_site_role not in ('owner', 'manager', 'accountant', 'collector', 'technician', 'viewer') then
    raise exception 'INVALID_SITE_ROLE' using errcode = 'P0001';
  end if;
  if nullif(trim(p_token_hash), '') is null or length(p_token_hash) > 128 then
    raise exception 'INVALID_TOKEN_HASH' using errcode = 'P0001';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'INVALID_EXPIRY' using errcode = 'P0001';
  end if;

  if v_site_id is not null then
    if not exists (select 1 from public.sites where id = v_site_id and tenant_id = p_tenant_id) then
      raise exception 'SITE_NOT_FOUND' using errcode = 'P0001';
    end if;
  end if;

  if p_tenant_role = 'owner' then
    v_site_role := 'owner';
  end if;

  insert into public.access_invitations (
    tenant_id, site_id, email, tenant_role, site_role, token_hash,
    status, invited_by_user_id, expires_at
  ) values (
    p_tenant_id, v_site_id, lower(trim(p_email)), p_tenant_role, v_site_role,
    p_token_hash, 'invited', p_actor_user_id, p_expires_at
  ) returning id into v_invitation_id;

  insert into public.platform_security_events(
    event_type, severity, status, title, details, metadata, related_user_id, created_by_user_id
  ) values (
    'security_change', 'info', 'success', 'دعوة وصول إلى المستأجر',
    'تم إنشاء دعوة وصول للمستأجر من خلال مسار Supabase الإداري.',
    jsonb_build_object(
      'tenantId', p_tenant_id,
      'siteId', v_site_id,
      'invitationId', v_invitation_id,
      'email', lower(trim(p_email)),
      'tenantRole', p_tenant_role,
      'siteRole', v_site_role,
      'status', 'invited',
      'expiresAt', p_expires_at
    ),
    null, p_actor_user_id
  );

  return query select v_invitation_id, lower(trim(p_email)), p_expires_at, 'invited';
end;
$$;

revoke all on function public.powerhub_admin_invite_tenant_access(bigint, bigint, bigint, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_admin_invite_tenant_access(bigint, bigint, bigint, text, text, text, text, timestamptz) to service_role;
