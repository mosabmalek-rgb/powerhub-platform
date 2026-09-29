-- Break mutual RLS recursion between chat_conversations and chat_participants.
-- The helpers execute with the table-owner security context so each policy can
-- inspect the related chat table without re-entering the sibling table's RLS.

create or replace function private.chat_rls_can_select_conversation(
  p_conversation_id bigint,
  p_tenant_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    (
      p_tenant_id = any(powerhub_private.current_tenant_ids())
      and exists (
        select 1
        from public.chat_participants cp
        where cp.conversation_id = p_conversation_id
          and cp.tenant_id = p_tenant_id
          and cp.user_id = powerhub_private.current_user_id()
          and cp.left_at is null
      )
    )
    or
    (
      private.powerhub_has_platform_capability('manageSupportChat')
      and exists (
        select 1
        from public.chat_conversations c
        where c.id = p_conversation_id
          and c.tenant_id = p_tenant_id
          and c.conversation_type = 'support'
      )
    );
$function$;

create or replace function private.chat_rls_can_select_participant(
  p_conversation_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_left_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    (
      p_user_id = powerhub_private.current_user_id()
      and p_left_at is null
      and p_tenant_id = any(powerhub_private.current_tenant_ids())
    )
    or
    (
      private.powerhub_has_platform_capability('manageSupportChat')
      and exists (
        select 1
        from public.chat_conversations c
        where c.id = p_conversation_id
          and c.tenant_id = p_tenant_id
          and c.conversation_type = 'support'
      )
    );
$function$;

revoke all on function private.chat_rls_can_select_conversation(bigint,bigint)
from public, anon, authenticated;
revoke all on function private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz)
from public, anon, authenticated;

drop policy if exists chat_conversations_select_participant on public.chat_conversations;
create policy chat_conversations_select_participant
on public.chat_conversations
for select
to authenticated
using (
  private.chat_rls_can_select_conversation(id, tenant_id)
);

drop policy if exists chat_participants_select_self_or_support on public.chat_participants;
create policy chat_participants_select_self_or_support
on public.chat_participants
for select
to authenticated
using (
  private.chat_rls_can_select_participant(
    conversation_id,
    tenant_id,
    user_id,
    left_at
  )
);
