-- Enforce the documented Support Center boundary on message and ticket metadata reads.
-- manageSupportChat grants cross-tenant access to support conversations, not to
-- assistant conversations or other tenant chat content. No table ACLs are changed.

DO $preflight$
DECLARE
  v_table text;
  v_tables constant text[] := ARRAY[
    'chat_messages','chat_conversation_tags','chat_support_assignments',
    'chat_ticket_events','chat_support_feedback'
  ];
BEGIN
  IF to_regprocedure('powerhub_private.current_user_id()') IS NULL
     OR to_regprocedure('private.powerhub_has_platform_capability(text)') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_SUPPORT_SCOPE_HELPERS_MISSING';
  END IF;
  IF NOT has_schema_privilege('authenticated','private','USAGE')
     OR NOT has_schema_privilege('authenticated','powerhub_private','USAGE')
     OR NOT has_function_privilege('authenticated','powerhub_private.current_user_id()','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_has_platform_capability(text)','EXECUTE') THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_SUPPORT_SCOPE_HELPER_GRANTS_MISSING';
  END IF;
  IF has_function_privilege('anon','powerhub_private.current_user_id()','EXECUTE')
     OR has_function_privilege('anon','private.powerhub_has_platform_capability(text)','EXECUTE') THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_SUPPORT_SCOPE_ANON_HELPER_ACCESS';
  END IF;

  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass(format('public.%I',v_table)) IS NULL THEN
      RAISE EXCEPTION 'POWERHUB_CHAT_SUPPORT_SCOPE_TABLE_MISSING: %',v_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid=to_regclass(format('public.%I',v_table))
        AND c.relrowsecurity=true
    ) THEN
      RAISE EXCEPTION 'POWERHUB_CHAT_SUPPORT_SCOPE_RLS_DISABLED: %',v_table;
    END IF;
  END LOOP;
END
$preflight$;

-- Preserve each existing tenant-user/self access path, but require support
-- capability AND conversation_type='support' for the cross-tenant branch.
DO $reconcile_chat_support_scope$
DECLARE
  v_table text;
  v_policy record;
  v_tables constant text[] := ARRAY[
    'chat_messages','chat_conversation_tags','chat_support_assignments',
    'chat_ticket_events','chat_support_feedback'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    FOR v_policy IN
      SELECT polname FROM pg_policy
      WHERE polrelid=to_regclass(format('public.%I',v_table))
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',v_policy.polname,v_table);
    END LOOP;
  END LOOP;
END
$reconcile_chat_support_scope$;

CREATE POLICY chat_messages_select_conversation_access
ON public.chat_messages FOR SELECT TO authenticated
USING (
  (
    private.powerhub_has_platform_capability('manageSupportChat')
    AND EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=chat_messages.conversation_id
        AND c.tenant_id=chat_messages.tenant_id
        AND c.conversation_type='support'
    )
  )
  OR
  (
    visibility='public'
    AND EXISTS (
      SELECT 1 FROM public.chat_participants cp
      WHERE cp.conversation_id=chat_messages.conversation_id
        AND cp.tenant_id=chat_messages.tenant_id
        AND cp.user_id=powerhub_private.current_user_id()
        AND cp.left_at IS NULL
    )
  )
);

CREATE POLICY chat_conversation_tags_select_access
ON public.chat_conversation_tags FOR SELECT TO authenticated
USING (
  (
    private.powerhub_has_platform_capability('manageSupportChat')
    AND EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=chat_conversation_tags.conversation_id
        AND c.tenant_id=chat_conversation_tags.tenant_id
        AND c.conversation_type='support'
    )
  )
  OR EXISTS (
    SELECT 1 FROM public.chat_participants cp
    WHERE cp.conversation_id=chat_conversation_tags.conversation_id
      AND cp.tenant_id=chat_conversation_tags.tenant_id
      AND cp.user_id=powerhub_private.current_user_id()
      AND cp.left_at IS NULL
  )
);

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

CREATE POLICY chat_support_feedback_select_own_or_support
ON public.chat_support_feedback FOR SELECT TO authenticated
USING (
  user_id=powerhub_private.current_user_id()
  OR
  (
    private.powerhub_has_platform_capability('manageSupportChat')
    AND EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=chat_support_feedback.conversation_id
        AND c.tenant_id=chat_support_feedback.tenant_id
        AND c.conversation_type='support'
    )
  )
);

SELECT pg_notify('pgrst','reload schema');
