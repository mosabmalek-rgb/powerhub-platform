-- Smart Support Chat v1 — server-side rate limiting.
-- Rate limits are enforced inside SECURITY DEFINER RPCs so browser callers
-- cannot bypass them by calling Supabase directly.
--
-- Policy:
--   * Message sends: max 30 per user per 60s, plus max 20 per conversation/user per 60s.
--   * Conversation creation: max 5 per user per 10m.
--   * Idempotent retries of an existing client_message_id do not consume quota.
--   * Advisory transaction locks make the counters safe under concurrent requests.

create table if not exists private.chat_rate_limit_buckets (
  user_id bigint not null references public.users(id) on delete cascade,
  scope text not null,
  bucket_start timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, scope, bucket_start)
);

revoke all on table private.chat_rate_limit_buckets from public, anon, authenticated;

after statement;

create index if not exists chat_rate_limit_buckets_user_updated_idx
  on private.chat_rate_limit_buckets (user_id, updated_at desc);

create or replace function private.chat_rate_limit_consume(
  p_user_id bigint,
  p_scope text,
  p_window_seconds integer,
  p_max_attempts integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_window_seconds integer := greatest(1, least(coalesce(p_window_seconds, 60), 3600));
  v_max_attempts integer := greatest(1, least(coalesce(p_max_attempts, 1), 1000));
  v_bucket_start timestamptz;
  v_attempts integer;
begin
  if p_user_id is null or nullif(btrim(p_scope), '') is null then
    return false;
  end if;

  v_bucket_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / v_window_seconds) * v_window_seconds
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      format('%s:%s:%s', p_user_id, btrim(p_scope), v_bucket_start),
      0
    )
  );

  delete from private.chat_rate_limit_buckets
  where user_id = p_user_id
    and bucket_start < clock_timestamp() - interval '2 hours';

  select attempts
    into v_attempts
  from private.chat_rate_limit_buckets
  where user_id = p_user_id
    and scope = btrim(p_scope)
    and bucket_start = v_bucket_start
  for update;

  if v_attempts is null then
    insert into private.chat_rate_limit_buckets (
      user_id, scope, bucket_start, attempts, updated_at
    ) values (
      p_user_id, btrim(p_scope), v_bucket_start, 1, clock_timestamp()
    );
    return true;
  end if;

  if v_attempts >= v_max_attempts then
    return false;
  end if;

  update private.chat_rate_limit_buckets
     set attempts = attempts + 1,
         updated_at = clock_timestamp()
   where user_id = p_user_id
     and scope = btrim(p_scope)
     and bucket_start = v_bucket_start;

  return true;
end;
$$;

revoke all on function private.chat_rate_limit_consume(bigint, text, integer, integer)
  from public, anon, authenticated;

create or replace function private.chat_create_conversation(
  p_tenant_id bigint,
  p_conversation_type text default 'assistant',
  p_subject text default null,
  p_priority text default 'normal'
)
returns public.chat_conversations
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_user_id bigint;
  v_row public.chat_conversations;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;
  if not (p_tenant_id = any(powerhub_private.current_tenant_ids())) then raise exception 'FORBIDDEN'; end if;
  if p_conversation_type not in ('assistant', 'support') then raise exception 'INVALID_CONVERSATION_TYPE'; end if;
  if p_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'INVALID_PRIORITY'; end if;

  if not private.chat_rate_limit_consume(
    v_user_id,
    format('conversation:%s', p_conversation_type),
    600,
    5
  ) then
    raise exception using errcode = 'P0001', message = 'RATE_LIMITED';
  end if;

  insert into public.chat_conversations (
    tenant_id, conversation_type, status, subject, priority, created_by_user_id, last_message_at
  ) values (
    p_tenant_id,
    p_conversation_type,
    case when p_conversation_type = 'support' then 'SUPPORT_PENDING' else 'AI_ACTIVE' end,
    nullif(btrim(p_subject), ''),
    p_priority,
    v_user_id,
    now()
  )
  returning * into v_row;

  insert into public.chat_participants (
    conversation_id, tenant_id, user_id, participant_role
  ) values (
    v_row.id, v_row.tenant_id, v_user_id, 'owner'
  );

  return v_row;
end;
$$;

create or replace function private.chat_send_message(
  p_conversation_id bigint,
  p_body text,
  p_client_message_id uuid,
  p_reply_to_message_id bigint default null
)
returns public.chat_messages
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_user_id bigint;
  v_conversation public.chat_conversations;
  v_row public.chat_messages;
  v_existing public.chat_messages;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;

  select * into v_conversation from public.chat_conversations where id = p_conversation_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not private.chat_can_access_conversation(p_conversation_id) then raise exception 'FORBIDDEN'; end if;
  if nullif(btrim(p_body), '') is null then raise exception 'INVALID_BODY'; end if;
  if length(p_body) > 8000 then raise exception 'BODY_TOO_LONG'; end if;
  if p_client_message_id is null then raise exception 'CLIENT_MESSAGE_ID_REQUIRED'; end if;

  if p_reply_to_message_id is not null and not exists (
    select 1 from public.chat_messages m
    where m.id = p_reply_to_message_id and m.conversation_id = p_conversation_id
  ) then raise exception 'INVALID_REPLY_TARGET'; end if;

  select * into v_existing
  from public.chat_messages
  where conversation_id = p_conversation_id
    and client_message_id = p_client_message_id;
  if found then
    if v_existing.sender_user_id is distinct from v_user_id then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return v_existing;
  end if;

  if not private.chat_rate_limit_consume(v_user_id, 'messages:global', 60, 30) then
    raise exception using errcode = 'P0001', message = 'RATE_LIMITED';
  end if;

  if not private.chat_rate_limit_consume(
    v_user_id,
    format('messages:conversation:%s', p_conversation_id),
    60,
    20
  ) then
    raise exception using errcode = 'P0001', message = 'RATE_LIMITED';
  end if;

  insert into public.chat_messages (
    conversation_id, tenant_id, sender_user_id, sender_type, message_type,
    body, reply_to_message_id, client_message_id
  ) values (
    v_conversation.id, v_conversation.tenant_id, v_user_id, 'human', 'text',
    btrim(p_body), p_reply_to_message_id, p_client_message_id
  )
  returning * into v_row;

  update public.chat_conversations
  set last_message_at = v_row.created_at, updated_at = now()
  where id = v_conversation.id;

  return v_row;
end;
$$;
