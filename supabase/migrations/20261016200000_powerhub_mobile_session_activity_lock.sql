-- Serialize mobile session activity/refresh with login claims. A device that
-- is actively making requests must not be reclaimed as stale by a racing login.
create or replace function public.powerhub_mobile_touch_session(
  p_session_id bigint,
  p_user_id bigint,
  p_tenant_id bigint,
  p_now timestamptz default clock_timestamp()
) returns boolean
language plpgsql
security definer
set search_path = ''
volatile
as $$
begin
  if p_session_id is null or p_session_id <= 0
     or p_user_id is null or p_user_id <= 0
     or p_tenant_id is null or p_tenant_id <= 0
     or p_now is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('powerhub-mobile-single-session:' || p_user_id::text, 0)
  );

  update public.mobile_api_sessions as s
     set last_used_at = p_now
   where s.id = p_session_id
     and s.user_id = p_user_id
     and s.tenant_id = p_tenant_id
     and s.revoked_at is null
     and s.expires_at > p_now;

  return found;
end;
$$;

revoke all on function public.powerhub_mobile_touch_session(bigint, bigint, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.powerhub_mobile_touch_session(bigint, bigint, bigint, timestamptz)
  to service_role;

-- Refresh-token rotation participates in the same user-level advisory lock as
-- login and activity touches. The initial read is non-locking; the guarded
-- update below re-validates the token after the advisory lock is acquired.
create or replace function public.powerhub_mobile_rotate_refresh_session(
  p_old_refresh_token_hash text,
  p_new_refresh_token_hash text,
  p_now timestamptz default now()
) returns table(id bigint, user_id bigint, tenant_id bigint)
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_user_id bigint;
begin
  if coalesce(p_old_refresh_token_hash, '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_new_refresh_token_hash, '') !~ '^[a-f0-9]{64}$'
     or p_now is null then
    return;
  end if;

  select s.user_id into v_user_id
    from public.mobile_api_sessions as s
   where s.refresh_token_hash = p_old_refresh_token_hash
     and s.revoked_at is null
     and s.expires_at > p_now
   limit 1;

  if v_user_id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('powerhub-mobile-single-session:' || v_user_id::text, 0)
  );

  return query
  update public.mobile_api_sessions as s
     set refresh_token_hash = p_new_refresh_token_hash,
         last_used_at = p_now
   where s.refresh_token_hash = p_old_refresh_token_hash
     and s.user_id = v_user_id
     and s.revoked_at is null
     and s.expires_at > p_now
   returning s.id, s.user_id, s.tenant_id;
end;
$$;

revoke all on function public.powerhub_mobile_rotate_refresh_session(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.powerhub_mobile_rotate_refresh_session(text, text, timestamptz)
  to service_role;
