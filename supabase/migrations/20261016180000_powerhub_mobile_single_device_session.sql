-- Enforce one active field-app device session per user, across tenants.
-- The advisory transaction lock makes the check-and-create operation atomic even
-- when two devices attempt to log in at the same time.
create or replace function public.powerhub_mobile_create_single_device_session(
  p_user_id bigint,
  p_tenant_id bigint,
  p_refresh_token_hash text,
  p_device_label text,
  p_expires_at timestamptz,
  p_now timestamptz default clock_timestamp()
) returns table(session_id bigint, session_status text)
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_session_id bigint;
  v_has_other_device boolean;
  v_device_fingerprint_supported boolean;
begin
  if p_user_id is null or p_user_id <= 0
     or p_tenant_id is null or p_tenant_id <= 0
     or coalesce(p_refresh_token_hash, '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_device_label, '') !~ '^PowerHub Field Reader:[a-f0-9]{64}$'
     or p_expires_at is null
     or p_now is null
     or p_expires_at <= p_now then
    raise exception 'invalid_mobile_session_request';
  end if;

  -- Lock by user, not tenant: one field-app account must not be active on
  -- separate devices even when the account can access multiple tenants.
  perform pg_advisory_xact_lock(
    hashtextextended('powerhub-mobile-device-session:' || p_user_id::text, 0)
  );

  -- Expired sessions must not strand an account on a device that no longer
  -- has a usable refresh token.
  update public.mobile_api_sessions
     set revoked_at = p_now
   where user_id = p_user_id
     and revoked_at is null
     and expires_at <= p_now;

  select exists (
    select 1
      from public.mobile_api_sessions s
     where s.user_id = p_user_id
       and s.revoked_at is null
       and s.expires_at > p_now
       and s.device_label is distinct from p_device_label
  ) into v_has_other_device;

  if v_has_other_device then
    return query select null::bigint, 'device_conflict'::text;
    return;
  end if;

  -- Same device re-authentication may rotate the session. Since the device
  -- fingerprint is installation/device-specific, this does not evict a
  -- different device. Revoke any still-live session for this user atomically.
  update public.mobile_api_sessions
     set revoked_at = p_now
   where user_id = p_user_id
     and revoked_at is null;

  insert into public.mobile_api_sessions (
    user_id, tenant_id, refresh_token_hash, device_label, expires_at
  ) values (
    p_user_id, p_tenant_id, p_refresh_token_hash, p_device_label, p_expires_at
  )
  returning id into v_session_id;

  return query select v_session_id, 'created'::text;
end;
$$;

revoke all on function public.powerhub_mobile_create_single_device_session(bigint, bigint, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.powerhub_mobile_create_single_device_session(bigint, bigint, text, text, timestamptz, timestamptz)
  to service_role;
