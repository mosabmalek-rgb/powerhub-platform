-- Smart Support Chat v1 — Support Center operator boundary.
-- Staging-first. Production deployment remains a separate release gate.
--
-- Security contract:
--   * Every operator mutation requires manageSupportChat.
--   * Actor identity comes from auth.uid() via private.chat_current_user_id().
--   * Assignment targets must themselves be active support operators.
--   * Tenant roles, manageMessaging, users.role='admin', and client actor ids
--     are never used as platform support grants.

create or replace function private.chat_assign_support(
  p_conversation_id bigint,
  p_assigned_user_id bigint
)
returns public.chat_support_assignments
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_actor_id bigint;
  v_conversation public.chat_conversations;
  v_assignment public.chat_support_assignments;
begin
  v_actor_id := private.chat_current_user_id();
  if v_actor_id is null then raise exception 'UNAUTHORIZED'; end if;
  if not private.powerhub_has_platform_capability('manageSupportChat') then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_conversation
  from public.chat_conversations
  where id = p_conversation_id;

  if not found then raise exception 'NOT_FOUND'; end if;
  if v_conversation.conversation_type <> 'support' then
    raise exception 'NOT_SUPPORT_CONVERSATION';
  end if;

  if not exists (
    select 1
    from private.chat_support_user_ids() support_user_id
    where support_user_id = p_assigned_user_id
  ) then
    raise exception 'INVALID_SUPPORT_ASSIGNEE';
  end if;

  update public.chat_support_assignments
     set status = 'released',
         released_at = now(),
         updated_at = now()
   where conversation_id = p_conversation_id
     and status in ('pending', 'active');

  insert into public.chat_support_assignments (
    conversation_id,
    tenant_id,
    assigned_user_id,
    assigned_by_user_id,
    status,
    assigned_at,
    accepted_at
  ) values (
    v_conversation.id,
    v_conversation.tenant_id,
    p_assigned_user_id,
    v_actor_id,
    'active',
    now(),
    now()
  )
  returning * into v_assignment;

  update public.chat_conversations
     set status = case
       when status in ('SUPPORT_PENDING', 'WAITING_USER') then 'SUPPORT_ACTIVE'
       else status
     end,
     resolved_at = null,
     closed_at = null,
     updated_at = now()
   where id = p_conversation_id;

  insert into public.chat_inbox_notifications (
    user_id,
    tenant_id,
    conversation_id,
    message_id,
    notification_type,
    title,
    body
  ) values (
    p_assigned_user_id,
    v_conversation.tenant_id,
    v_conversation.id,
    null,
    'support_update',
    'تم إسناد محادثة دعم إليك',
    coalesce(v_conversation.subject, 'محادثة دعم PowerHub')
  );

  return v_assignment;
end;
$$;

create or replace function private.chat_release_support(
  p_conversation_id bigint
)
returns public.chat_support_assignments
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_assignment public.chat_support_assignments;
begin
  if private.chat_current_user_id() is null then raise exception 'UNAUTHORIZED'; end if;
  if not private.powerhub_has_platform_capability('manageSupportChat') then
    raise exception 'FORBIDDEN';
  end if;

  update public.chat_support_assignments
     set status = 'released',
         released_at = now(),
         updated_at = now()
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

create or replace function public.chat_assign_support(
  p_conversation_id bigint,
  p_assigned_user_id bigint
)
returns public.chat_support_assignments
language sql
security invoker
set search_path = ''
as $$
  select private.chat_assign_support($1, $2);
$$;

create or replace function public.chat_release_support(
  p_conversation_id bigint
)
returns public.chat_support_assignments
language sql
security invoker
set search_path = ''
as $$
  select private.chat_release_support($1);
$$;

revoke execute on function private.chat_assign_support(bigint, bigint) from public, anon, authenticated;
revoke execute on function private.chat_release_support(bigint) from public, anon, authenticated;
revoke execute on function public.chat_assign_support(bigint, bigint) from public, anon;
revoke execute on function public.chat_release_support(bigint) from public, anon;
grant execute on function public.chat_assign_support(bigint, bigint) to authenticated;
grant execute on function public.chat_release_support(bigint) to authenticated;

create policy chat_support_receive_conversation
on realtime.messages
for select to authenticated
using (
  private = true
  and extension = 'broadcast'
  and topic ~ '^chat:conversation:[0-9]+$'
  and private.powerhub_has_platform_capability('manageSupportChat')
);

create policy chat_support_send_conversation
on realtime.messages
for insert to authenticated
with check (
  private = true
  and extension = 'broadcast'
  and topic ~ '^chat:conversation:[0-9]+$'
  and private.powerhub_has_platform_capability('manageSupportChat')
);
