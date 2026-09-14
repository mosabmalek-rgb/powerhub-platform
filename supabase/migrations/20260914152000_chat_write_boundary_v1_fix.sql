-- Fix: use the existing PowerHub tenant/user resolvers already shared by RLS.
-- Do not create a parallel tenant authorization helper for chat.

create or replace function private.chat_current_user_id()
returns bigint
language sql
security definer
set search_path = ''
stable
as $$
  select powerhub_private.current_user_id();
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
  if not (p_tenant_id = any(powerhub_private.current_tenant_ids())) then raise exception 'FORBIDDEN'; end if;
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
