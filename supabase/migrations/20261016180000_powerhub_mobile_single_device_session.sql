-- Enforce at most one active field-app session per user, including across tenants.
-- Keep the most recently used valid session for existing accounts that had multiple
-- sessions before this policy existed; revoke the older sessions once, at migration.
with ranked_sessions as (
  select id,
         row_number() over (
           partition by user_id
           order by last_used_at desc nulls last, created_at desc, id desc
         ) as session_rank
    from public.mobile_api_sessions
   where revoked_at is null
     and expires_at > clock_timestamp()
)
update public.mobile_api_sessions as s
   set revoked_at = clock_timestamp()
  from ranked_sessions as r
 where s.id = r.id
   and r.session_rank > 1;

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
  v_has_active_session boolean;
begin
  if p_user_id is null or p_user_id <= 0
     or p_tenant_id is null or p_tenant_id <= 0
     or coalesce(p_refresh_token_hash, '') !~ '^[a-f0-9]{64}$'
     or coalesce(btrim(p_device_label), '') = ''
     or length(p_device_label) > 160
     or p_expires_at is null
     or p_now is null
     or p_expires_at <= p_now then
    raise exception 'invalid_mobile_session_request';
  end if;

  -- Lock by user, not tenant: the same field account must not be active on two
  -- devices or in two tenant workspaces at the same time.
  perform pg_advisory_xact_lock(
    hashtextextended('powerhub-mobile-single-session:' || p_user_id::text, 0)
  );

  -- Expired sessions must not block a legitimate login forever.
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
  ) into v_has_active_session;

  if v_has_active_session then
    return query select null::bigint, 'already_active'::text;
    return;
  end if;

  insert into public.mobile_api_sessions (
    user_id, tenant_id, refresh_token_hash, device_label, expires_at
  ) values (
    p_user_id, p_tenant_id, p_refresh_token_hash, btrim(p_device_label), p_expires_at
  )
  returning id into v_session_id;

  return query select v_session_id, 'created'::text;
end;
$$;

revoke all on function public.powerhub_mobile_create_single_device_session(bigint, bigint, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.powerhub_mobile_create_single_device_session(bigint, bigint, text, text, timestamptz, timestamptz)
  to service_role;
