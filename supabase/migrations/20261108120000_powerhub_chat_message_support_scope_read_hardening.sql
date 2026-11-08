-- Restrict platform support's browser SELECT on messages and ticket metadata to support conversations.
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
  -- These four metadata read policies are broad in Production as well.
  -- Fail closed instead of hardening messages alone and leaving metadata exposed.
  -- Do NOT grant table SELECT here: tags/ticket events are deliberately
  -- server-only in some deployed environments; this change only narrows RLS.
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('chat_conversation_tags','chat_conversation_tags_select_access'),
      ('chat_support_assignments','chat_assignments_select_support_only'),
      ('chat_ticket_events','chat_ticket_events_select_support'),
      ('chat_support_feedback','chat_support_feedback_select_own_or_support')
    ) AS required(table_name, policy_name)
    WHERE to_regclass(format('public.%I', required.table_name)) IS NULL
       OR NOT coalesce((SELECT relrowsecurity FROM pg_class
                        WHERE oid=to_regclass(format('public.%I', required.table_name))), false)
       OR NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename=required.table_name
           AND policyname=required.policy_name AND cmd='SELECT'
           AND roles @> ARRAY['authenticated']::name[]
       )
       OR has_table_privilege('anon',
             to_regclass(format('public.%I',required.table_name)),'SELECT')
  ) THEN
    RAISE EXCEPTION 'CHAT_SUPPORT_METADATA_READ_PRECONDITION_DRIFT';
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


-- Preserve the participant/self branch but restrict platform support's broad
-- capability path to matching support conversations and matching tenant IDs.
DROP POLICY chat_conversation_tags_select_access ON public.chat_conversation_tags;
CREATE POLICY chat_conversation_tags_select_access
ON public.chat_conversation_tags FOR SELECT TO authenticated
USING (
  private.chat_rls_can_select_conversation(conversation_id, tenant_id)
);

DROP POLICY chat_assignments_select_support_only ON public.chat_support_assignments;
CREATE POLICY chat_assignments_select_support_only
ON public.chat_support_assignments FOR SELECT TO authenticated
USING (
  private.powerhub_has_platform_capability('manageSupportChat')
  AND EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=chat_support_assignments.conversation_id
      AND c.tenant_id=chat_support_assignments.tenant_id
      AND c.conversation_type='support'
  )
);

DROP POLICY chat_ticket_events_select_support ON public.chat_ticket_events;
CREATE POLICY chat_ticket_events_select_support
ON public.chat_ticket_events FOR SELECT TO authenticated
USING (
  private.powerhub_has_platform_capability('manageSupportChat')
  AND EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=chat_ticket_events.conversation_id
      AND c.tenant_id=chat_ticket_events.tenant_id
      AND c.conversation_type='support'
  )
);

DROP POLICY chat_support_feedback_select_own_or_support ON public.chat_support_feedback;
CREATE POLICY chat_support_feedback_select_own_or_support
ON public.chat_support_feedback FOR SELECT TO authenticated
USING (
  (
    user_id=powerhub_private.current_user_id()
    AND tenant_id=ANY(powerhub_private.current_tenant_ids())
    AND EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=chat_support_feedback.conversation_id
        AND c.tenant_id=chat_support_feedback.tenant_id
    )
  )
  OR (
    private.powerhub_has_platform_capability('manageSupportChat')
    AND EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=chat_support_feedback.conversation_id
        AND c.tenant_id=chat_support_feedback.tenant_id
        AND c.conversation_type='support'
    )
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
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('chat_conversation_tags','chat_conversation_tags_select_access','chat_rls_can_select_conversation'),
      ('chat_support_assignments','chat_assignments_select_support_only','conversation_type'),
      ('chat_ticket_events','chat_ticket_events_select_support','conversation_type'),
      ('chat_support_feedback','chat_support_feedback_select_own_or_support','conversation_type')
    ) AS required(table_name,policy_name,expected)
    LEFT JOIN pg_class tab ON tab.oid=to_regclass(format('public.%I',required.table_name))
    LEFT JOIN pg_policy policy ON policy.polrelid=tab.oid AND policy.polname=required.policy_name AND policy.polcmd='r'
    WHERE policy.oid IS NULL OR position(required.expected IN
      coalesce(pg_get_expr(policy.polqual,policy.polrelid),''))=0
  ) THEN
    RAISE EXCEPTION 'CHAT_SUPPORT_METADATA_READ_POSTFLIGHT_FAILED';
  END IF;
END
$postflight$;
