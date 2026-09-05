-- Add a portal-wide ceiling in addition to the per-identity limit.
-- This prevents attackers from rotating subscriber numbers to bypass the per-identity window.

create or replace function public.powerhub_subscriber_portal_check_rate_limit(
  p_portal_code text,
  p_request_fingerprint text,
  p_window_seconds integer default 300,
  p_max_attempts integer default 8
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_identity_count integer;
  v_portal_count integer;
  v_window_seconds integer := greatest(1, least(p_window_seconds, 3600));
begin
  if length(btrim(coalesce(p_portal_code, ''))) < 2 or length(btrim(coalesce(p_request_fingerprint, ''))) < 16 then
    return false;
  end if;

  select count(*)::integer into v_identity_count
  from public.subscriber_portal_attempts
  where portal_code = lower(btrim(p_portal_code))
    and request_fingerprint = p_request_fingerprint
    and attempted_at >= now() - make_interval(secs => v_window_seconds);

  if v_identity_count >= greatest(1, least(p_max_attempts, 100)) then
    return false;
  end if;

  select count(*)::integer into v_portal_count
  from public.subscriber_portal_attempts
  where portal_code = lower(btrim(p_portal_code))
    and attempted_at >= now() - make_interval(secs => v_window_seconds);

  return v_portal_count < 120;
end;
$$;

revoke all on function public.powerhub_subscriber_portal_check_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.powerhub_subscriber_portal_check_rate_limit(text, text, integer, integer) to service_role;
