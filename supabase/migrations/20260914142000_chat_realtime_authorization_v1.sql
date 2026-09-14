-- PowerHub Smart Support Chat v1 — Realtime Authorization.
-- DESIGN-APPROVED / NOT DEPLOYED TO Production.
--
-- Channels:
--   chat:conversation:{conversation_id}
--   chat:support:queue
--
-- Private channels are mandatory. Topic text is never treated as a security
-- boundary by itself; every decision resolves current DB authorization state.

create policy chat_conversation_receive
on realtime.messages
for select to authenticated
using (
  private = true
  and extension = 'broadcast'
  and (
    (
      topic ~ '^chat:conversation:[0-9]+$'
      and exists (
        select 1
        from public.chat_conversations c
        join public.chat_participants cp
          on cp.conversation_id = c.id
         and cp.tenant_id = c.tenant_id
        where c.id = substring(topic from 'chat:conversation:([0-9]+)$')::bigint
          and cp.user_id = powerhub_private.current_user_id()
          and cp.left_at is null
      )
    )
    or (
      topic = 'chat:support:queue'
      and private.powerhub_has_platform_capability('manageSupportChat')
    )
  )
);

create policy chat_conversation_send
on realtime.messages
for insert to authenticated
with check (
  private = true
  and extension = 'broadcast'
  and (
    (
      topic ~ '^chat:conversation:[0-9]+$'
      and exists (
        select 1
        from public.chat_conversations c
        join public.chat_participants cp
          on cp.conversation_id = c.id
         and cp.tenant_id = c.tenant_id
        where c.id = substring(topic from 'chat:conversation:([0-9]+)$')::bigint
          and cp.user_id = powerhub_private.current_user_id()
          and cp.left_at is null
      )
    )
    or (
      topic = 'chat:support:queue'
      and private.powerhub_has_platform_capability('manageSupportChat')
    )
  )
);

-- Client contract: use config: { private: true } for every channel.
-- Production Realtime must have public-channel access disabled before release.