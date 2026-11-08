-- Restrict platform support's browser SELECT capability to support conversations.
-- Production currently has an unqualified manageSupportChat arm in the
-- chat_messages SELECT policy, which can expose non-support message rows.
-- Source-only pending Staging and Production release gates.
DO $preflight$
BEGIN
  IF to_regclass('public.chat_messages') IS NULL
     OR to_regclass('public.chat_conversations') IS NULL
     OR to_regprocedure('private.powerhub_has_platform_capability(text)') IS NULL
     OR to_regprocedure('private.chat_rls_can_select_conversation(bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'CHAT_MESSAGE_READ_HARDENING_DEPENDENCY_MISSING';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.chat_messages'::regclass) THEN
    RAISE EXCEPTION 'CHAT_MESSAGE_READ_HARDENING_RLS_DISABLED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='chat_messages'
      AND policyname='chat_messages_select_conversation_access'
      AND cmd='SELECT'
  ) THEN
    RAISE EXCEPTION 'CHAT_MESSAGE_READ_HARDENING_POLICY_MISSING';
  END IF;
  IF NOT has_table_privilege('authenticated','public.chat_messages','SELECT')
     OR has_table_privilege('anon','public.chat_messages','SELECT') THEN
    RAISE EXCEPTION 'CHAT_MESSAGE_READ_HARDENING_TABLE_ACL_DRIFT';
  END IF;
END
$preflight$;

DROP POLICY chat_messages_select_conversation_access ON public.chat_messages;
CREATE POLICY chat_messages_select_conversation_access
ON public.chat_messages FOR SELECT TO authenticated
USING (
  (
    private.powerhub_has_platform_capability('manageSupportChat')
    AND EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id = chat_messages.conversation_id
        AND c.tenant_id = chat_messages.tenant_id
        AND c.conversation_type = 'support'
    )
  )
  OR (
    visibility = 'public'
    AND private.chat_rls_can_select_conversation(conversation_id, tenant_id)
  )
);

DO $postflight$
DECLARE v_expression text;
BEGIN
  SELECT pg_get_expr(p.polqual,p.polrelid) INTO v_expression
  FROM pg_policy p
  WHERE p.polrelid='public.chat_messages'::regclass
    AND p.polname='chat_messages_select_conversation_access'
    AND p.polcmd='r';
  IF v_expression IS NULL
     OR position('conversation_type' IN v_expression)=0
     OR position('manageSupportChat' IN v_expression)=0
     OR position('chat_rls_can_select_conversation' IN v_expression)=0 THEN
    RAISE EXCEPTION 'CHAT_MESSAGE_READ_HARDENING_POSTFLIGHT_FAILED';
  END IF;
END
$postflight$;
