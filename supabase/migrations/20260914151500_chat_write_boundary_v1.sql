-- Smart Support Chat v1: server/RPC write boundary.
-- Client identity is always resolved from auth.uid(); actor/user ids are never accepted.
-- Browser clients have no direct table write grants/policies; these RPCs are the only v1 write path.

create or replace function private.chat_current_user_id()
returns bigint
language sql
security definer
set search_path = ''
stable
as $$
  select u.id
  from public.users u
  where u.auth_user_id = auth.uid()
    and u.account_status = 'active'
  limit 1;
$$;

create or replace function private.chat_can_access_conversation(p_conversation_id bigint)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.chat_conversations c
    where c.id = p_conversation_id
      and (
        exists (
          select 1
          from public.chat_participants cp
          join public.tenant_members tm
            on tm.tenant_id = c.tenant_id
           and tm.user_id = cp.user_id
          where cp.conversation_id = c.id
            and cp.user_id = private.chat_current_user_id()
            and cp.left_at is null
            and tm.is_active = true
            and (tm.expires_at is null or tm.expires_at > now())
        )
        or private.powerhub_has_platform_capability('manageSupportChat')
      )
  );
$$;

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
  if not private.powerhub_has_tenant_access(p_tenant_id) then raise exception 'FORBIDDEN'; end if;
  if p_conversation_type not in ('assistant', 'support') then raise exception 'INVALID_CONVERSATION_TYPE'; end if;
  if p_priority not in ('low', 'normal', 'high', 'urgent') then raise exception 'INVALID_PRIORITY'; end if;

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

create or replace function private.chat_transition_conversation(
  p_conversation_id bigint,
  p_next_status text
)
returns public.chat_conversations
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_user_id bigint;
  v_conversation public.chat_conversations;
  v_is_support boolean;
  v_is_participant boolean;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;

  select * into v_conversation from public.chat_conversations where id = p_conversation_id;
  if not found then raise exception 'NOT_FOUND'; end if;

  v_is_support := private.powerhub_has_platform_capability('manageSupportChat');
  v_is_participant := exists (
    select 1
    from public.chat_participants cp
    join public.tenant_members tm
      on tm.tenant_id = v_conversation.tenant_id and tm.user_id = cp.user_id
    where cp.conversation_id = v_conversation.id
      and cp.user_id = v_user_id
      and cp.left_at is null
      and tm.is_active = true
      and (tm.expires_at is null or tm.expires_at > now())
  );

  if not v_is_support and not v_is_participant then raise exception 'FORBIDDEN'; end if;

  if v_is_support then
    if not (
      (v_conversation.status = 'SUPPORT_PENDING' and p_next_status = 'SUPPORT_ACTIVE') or
      (v_conversation.status = 'SUPPORT_ACTIVE' and p_next_status in ('WAITING_USER', 'RESOLVED')) or
      (v_conversation.status = 'WAITING_USER' and p_next_status = 'SUPPORT_ACTIVE') or
      (v_conversation.status = 'RESOLVED' and p_next_status in ('CLOSED', 'SUPPORT_ACTIVE'))
    ) then raise exception 'INVALID_STATUS_TRANSITION'; end if;
  else
    if not (v_conversation.status = 'AI_ACTIVE' and p_next_status = 'SUPPORT_PENDING') then
      raise exception 'INVALID_STATUS_TRANSITION';
    end if;
  end if;

  update public.chat_conversations
  set status = p_next_status,
      resolved_at = case
        when p_next_status in ('RESOLVED', 'CLOSED') and resolved_at is null then now()
        when p_next_status = 'SUPPORT_ACTIVE' then null
        else resolved_at
      end,
      closed_at = case
        when p_next_status = 'CLOSED' then now()
        when p_next_status <> 'CLOSED' then null
        else closed_at
      end,
      updated_at = now()
  where id = p_conversation_id
  returning * into v_conversation;

  return v_conversation;
end;
$$;

create or replace function public.chat_create_conversation(
  p_tenant_id bigint,
  p_conversation_type text default 'assistant',
  p_subject text default null,
  p_priority text default 'normal'
)
returns public.chat_conversations
language sql
security invoker
set search_path = ''
as $$ select private.chat_create_conversation($1, $2, $3, $4); $$;

create or replace function public.chat_send_message(
  p_conversation_id bigint,
  p_body text,
  p_client_message_id uuid,
  p_reply_to_message_id bigint default null
)
returns public.chat_messages
language sql
security invoker
set search_path = ''
as $$ select private.chat_send_message($1, $2, $3, $4); $$;

create or replace function public.chat_transition_conversation(
  p_conversation_id bigint,
  p_next_status text
)
returns public.chat_conversations
language sql
security invoker
set search_path = ''
as $$ select private.chat_transition_conversation($1, $2); $$;

revoke execute on function public.chat_create_conversation(bigint, text, text, text) from public, anon;
revoke execute on function public.chat_send_message(bigint, text, uuid, bigint) from public, anon;
revoke execute on function public.chat_transition_conversation(bigint, text) from public, anon;

grant execute on function public.chat_create_conversation(bigint, text, text, text) to authenticated;
grant execute on function public.chat_send_message(bigint, text, uuid, bigint) to authenticated;
grant execute on function public.chat_transition_conversation(bigint, text) to authenticated;
