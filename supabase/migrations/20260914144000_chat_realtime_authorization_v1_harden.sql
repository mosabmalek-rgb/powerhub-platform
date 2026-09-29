-- Harden Realtime authorization by requiring both current participant membership
-- and active tenant membership. The channel topic is not a security boundary.

DROP POLICY IF EXISTS chat_conversation_receive ON realtime.messages;
DROP POLICY IF EXISTS chat_conversation_send ON realtime.messages;

CREATE POLICY chat_conversation_receive
ON realtime.messages
FOR SELECT TO authenticated
USING (
  private = true
  AND extension = 'broadcast'
  AND (
    (
      topic ~ '^chat:conversation:[0-9]+$'
      AND EXISTS (
        SELECT 1
        FROM public.chat_conversations c
        JOIN public.chat_participants cp
          ON cp.conversation_id = c.id
         AND cp.tenant_id = c.tenant_id
        JOIN public.tenant_members tm
          ON tm.tenant_id = c.tenant_id
         AND tm.user_id = cp.user_id
        WHERE c.id = substring(topic from 'chat:conversation:([0-9]+)$')::bigint
          AND cp.user_id = powerhub_private.current_user_id()
          AND cp.left_at IS NULL
          AND tm.user_id = powerhub_private.current_user_id()
          AND tm.is_active
          AND tm.membership_status = 'active'
      )
    )
    OR (
      topic = 'chat:support:queue'
      AND private.powerhub_has_platform_capability('manageSupportChat')
    )
  )
);

CREATE POLICY chat_conversation_send
ON realtime.messages
FOR INSERT TO authenticated
WITH CHECK (
  private = true
  AND extension = 'broadcast'
  AND (
    (
      topic ~ '^chat:conversation:[0-9]+$'
      AND EXISTS (
        SELECT 1
        FROM public.chat_conversations c
        JOIN public.chat_participants cp
          ON cp.conversation_id = c.id
         AND cp.tenant_id = c.tenant_id
        JOIN public.tenant_members tm
          ON tm.tenant_id = c.tenant_id
         AND tm.user_id = cp.user_id
        WHERE c.id = substring(topic from 'chat:conversation:([0-9]+)$')::bigint
          AND cp.user_id = powerhub_private.current_user_id()
          AND cp.left_at IS NULL
          AND tm.user_id = powerhub_private.current_user_id()
          AND tm.is_active
          AND tm.membership_status = 'active'
      )
    )
    OR (
      topic = 'chat:support:queue'
      AND private.powerhub_has_platform_capability('manageSupportChat')
    )
  )
);