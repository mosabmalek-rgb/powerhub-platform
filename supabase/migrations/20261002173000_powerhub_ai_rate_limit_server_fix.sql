-- Server-side AI rate limiting.
-- The server passes the already-authenticated internal PowerHub user id.
-- Browser roles have no EXECUTE privilege.

drop function if exists public.chat_ai_rate_limit(integer,integer);

create or replace function public.chat_ai_rate_limit(
  p_user_id bigint,
  p_limit integer default 12,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path=''
volatile
as $$
declare
  v_now timestamptz := now();
  v_allowed boolean;
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' then
    raise exception 'INTERNAL_ONLY';
  end if;

  if p_user_id is null or p_limit < 1 or p_limit > 60
     or p_window_seconds < 10 or p_window_seconds > 3600 then
    raise exception 'INVALID_RATE_LIMIT_POLICY';
  end if;

  if not exists (select 1 from public.users where id=p_user_id) then
    raise exception 'USER_NOT_FOUND';
  end if;

  insert into private.chat_ai_rate_limit_buckets(
    user_id,window_started_at,requests_count,updated_at
  )
  values(p_user_id,v_now,1,v_now)
  on conflict(user_id) do update
  set
    window_started_at=case
      when private.chat_ai_rate_limit_buckets.window_started_at
           + make_interval(secs => p_window_seconds) <= v_now
        then v_now
      else private.chat_ai_rate_limit_buckets.window_started_at
    end,
    requests_count=case
      when private.chat_ai_rate_limit_buckets.window_started_at
           + make_interval(secs => p_window_seconds) <= v_now
        then 1
      else private.chat_ai_rate_limit_buckets.requests_count + 1
    end,
    updated_at=v_now;

  select b.requests_count <= p_limit
  into v_allowed
  from private.chat_ai_rate_limit_buckets b
  where b.user_id=p_user_id;

  return coalesce(v_allowed,false);
end;
$$;

revoke all on function public.chat_ai_rate_limit(bigint,integer,integer)
  from public,anon,authenticated;
grant execute on function public.chat_ai_rate_limit(bigint,integer,integer)
  to service_role;
