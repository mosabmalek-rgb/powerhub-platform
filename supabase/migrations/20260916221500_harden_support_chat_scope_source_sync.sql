-- Sync production support-chat scope hardening into source control.
-- Support operators may access/write support conversations only.
-- Tenant participants retain normal participant-scoped access.

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
        or (
          c.conversation_type = 'support'
          and private.powerhub_has_platform_capability('manageSupportChat')
        )
      )
  );
$$;

create or replace function private.chat_release_support(p_conversation_id bigint)
returns public.chat_support_assignments
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_assignment public.chat_support_assignments;
  v_conversation public.chat_conversations;
begin
  if private.chat_current_user_id() is null then raise exception 'UNAUTHORIZED'; end if;
  if not private.powerhub_has_platform_capability('manageSupportChat') then raise exception 'FORBIDDEN'; end if;

  select * into v_conversation
  from public.chat_conversations
  where id = p_conversation_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_conversation.conversation_type <> 'support' then raise exception 'NOT_SUPPORT_CONVERSATION'; end if;

  update public.chat_support_assignments
  set status = 'released', released_at = now(), updated_at = now()
  where conversation_id = p_conversation_id
    and status in ('pending', 'active')
  returning * into v_assignment;

  if not found then raise exception 'NOT_FOUND'; end if;

  update public.chat_conversations
  set status = case
        when status in ('SUPPORT_ACTIVE', 'WAITING_USER') then 'SUPPORT_PENDING'
        else status
      end,
      updated_at = now()
  where id = p_conversation_id;

  return v_assignment;
end;
$$;

-- Browser roles must use the reviewed public RPC wrappers.
revoke execute on function public.chat_send_message(bigint, text, uuid, bigint) from public, anon;
grant execute on function public.chat_send_message(bigint, text, uuid, bigint) to authenticated;
