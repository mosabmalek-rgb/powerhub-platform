-- Reconcile internal AI RPC guards with Supabase service-role execution.
-- The application server calls these functions through a service-role Supabase client.
-- Authorization is enforced by EXECUTE ACL: service_role only.
-- Do not depend on request.jwt.claim.role, which is not guaranteed on this execution path.

create or replace function public.chat_ai_claim_request(
  p_request_id text,
  p_conversation_id bigint,
  p_message_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_lease_seconds integer default 45
)
returns boolean
language plpgsql
security definer
set search_path=''
volatile
as $function$
declare
  v_now timestamptz := now();
begin
  if nullif(btrim(p_request_id),'') is null
     or p_lease_seconds < 10
     or p_lease_seconds > 180 then
    raise exception 'INVALID_CLAIM';
  end if;

  insert into private.chat_ai_request_claims(
    request_id,conversation_id,message_id,tenant_id,user_id,claimed_at,expires_at
  )
  values(
    p_request_id,p_conversation_id,p_message_id,p_tenant_id,p_user_id,
    v_now,v_now + make_interval(secs => p_lease_seconds)
  )
  on conflict(request_id) do update
    set conversation_id=excluded.conversation_id,
        message_id=excluded.message_id,
        tenant_id=excluded.tenant_id,
        user_id=excluded.user_id,
        claimed_at=excluded.claimed_at,
        expires_at=excluded.expires_at
    where private.chat_ai_request_claims.expires_at <= v_now;

  return exists(
    select 1
    from private.chat_ai_request_claims c
    where c.request_id=p_request_id
      and c.claimed_at >= v_now - interval '1 second'
  );
end;
$function$;

revoke all on function public.chat_ai_claim_request(text,bigint,bigint,bigint,bigint,integer)
  from public,anon,authenticated;
grant execute on function public.chat_ai_claim_request(text,bigint,bigint,bigint,bigint,integer)
  to service_role;

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
as $function$
declare
  v_now timestamptz := now();
  v_allowed boolean;
begin
  if p_user_id is null
     or p_limit < 1 or p_limit > 60
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
  set window_started_at=case
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
$function$;

revoke all on function public.chat_ai_rate_limit(bigint,integer,integer)
  from public,anon,authenticated;
grant execute on function public.chat_ai_rate_limit(bigint,integer,integer)
  to service_role;
