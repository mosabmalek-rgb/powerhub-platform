-- Concurrency-safe AI request claims.
-- Prevents two concurrent retries from invoking the LLM for the same user message.

create table if not exists private.chat_ai_request_claims (
  request_id text primary key,
  conversation_id bigint not null references public.chat_conversations(id) on delete cascade,
  message_id bigint not null references public.chat_messages(id) on delete cascade,
  tenant_id bigint not null references public.tenants(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_ai_request_claims_expiry_idx
  on private.chat_ai_request_claims(expires_at);

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
as $$
declare
  v_now timestamptz := now();
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' then
    raise exception 'INTERNAL_ONLY';
  end if;

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
$$;

revoke all on function public.chat_ai_claim_request(text,bigint,bigint,bigint,bigint,integer)
  from public,anon,authenticated;
grant execute on function public.chat_ai_claim_request(text,bigint,bigint,bigint,bigint,integer)
  to service_role;
