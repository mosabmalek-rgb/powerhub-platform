-- Reconcile Staging chat RLS to the verified Production conversation boundary.
-- Support operators may inspect support conversations only; ordinary tenant users
-- must be active tenant members and participants in the requested conversation.
-- Browser grants remain SELECT-only. Server/RPC write boundaries are unchanged.

DO $preflight$
DECLARE
  v_table text;
  v_tables constant text[] := ARRAY[
    'chat_conversations','chat_participants','chat_bot_handoffs',
    'chat_message_attachments','chat_message_receipts'
  ];
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('powerhub_private.current_user_id()') IS NULL
     OR to_regprocedure('powerhub_private.current_tenant_ids()') IS NULL
     OR to_regprocedure('private.powerhub_has_platform_capability(text)') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_RLS_HELPERS_MISSING';
  END IF;

  IF NOT has_schema_privilege('authenticated','private','USAGE')
     OR NOT has_schema_privilege('authenticated','powerhub_private','USAGE')
     OR NOT has_function_privilege('authenticated','powerhub_private.current_user_id()','EXECUTE')
     OR NOT has_function_privilege('authenticated','powerhub_private.current_tenant_ids()','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_has_platform_capability(text)','EXECUTE') THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_RLS_HELPER_GRANTS_MISSING';
  END IF;

  IF has_schema_privilege('anon','private','USAGE')
     OR has_schema_privilege('anon','powerhub_private','USAGE')
     OR has_function_privilege('anon','powerhub_private.current_user_id()','EXECUTE')
     OR has_function_privilege('anon','powerhub_private.current_tenant_ids()','EXECUTE')
     OR has_function_privilege('anon','private.powerhub_has_platform_capability(text)','EXECUTE') THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_ANON_HELPER_ACCESS_MUST_REMAIN_REVOKED';
  END IF;

  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass(format('public.%I',v_table)) IS NULL THEN
      RAISE EXCEPTION 'POWERHUB_CHAT_RLS_TABLE_MISSING: %',v_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid=to_regclass(format('public.%I',v_table))
        AND c.relrowsecurity=true
    ) THEN
      RAISE EXCEPTION 'POWERHUB_CHAT_RLS_DISABLED: %',v_table;
    END IF;
    IF has_table_privilege('anon',to_regclass(format('public.%I',v_table)),'SELECT')
       OR has_table_privilege('anon',to_regclass(format('public.%I',v_table)),'INSERT')
       OR has_table_privilege('anon',to_regclass(format('public.%I',v_table)),'UPDATE')
       OR has_table_privilege('anon',to_regclass(format('public.%I',v_table)),'DELETE')
       OR has_table_privilege('anon',to_regclass(format('public.%I',v_table)),'TRUNCATE') THEN
      RAISE EXCEPTION 'POWERHUB_CHAT_ANON_TABLE_ACCESS_MUST_REMAIN_REVOKED: %',v_table;
    END IF;
    IF NOT has_table_privilege('authenticated',to_regclass(format('public.%I',v_table)),'SELECT')
       OR has_table_privilege('authenticated',to_regclass(format('public.%I',v_table)),'INSERT')
       OR has_table_privilege('authenticated',to_regclass(format('public.%I',v_table)),'UPDATE')
       OR has_table_privilege('authenticated',to_regclass(format('public.%I',v_table)),'DELETE')
       OR has_table_privilege('authenticated',to_regclass(format('public.%I',v_table)),'TRUNCATE') THEN
      RAISE EXCEPTION 'POWERHUB_CHAT_AUTHENTICATED_GRANTS_MISMATCH: %',v_table;
    END IF;
    IF NOT has_table_privilege('service_role',to_regclass(format('public.%I',v_table)),'SELECT')
       OR NOT has_table_privilege('service_role',to_regclass(format('public.%I',v_table)),'INSERT')
       OR NOT has_table_privilege('service_role',to_regclass(format('public.%I',v_table)),'UPDATE')
       OR NOT has_table_privilege('service_role',to_regclass(format('public.%I',v_table)),'DELETE') THEN
      RAISE EXCEPTION 'POWERHUB_CHAT_SERVICE_ROLE_GRANTS_MISSING: %',v_table;
    END IF;
  END LOOP;
END
$preflight$;

-- SECURITY DEFINER helpers break chat_conversations/chat_participants policy
-- recursion without changing the caller identity or membership authority.
CREATE OR REPLACE FUNCTION private.chat_rls_can_select_conversation(
  p_conversation_id bigint,
  p_tenant_id bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    (
      p_tenant_id = ANY(powerhub_private.current_tenant_ids())
      AND EXISTS (
        SELECT 1
        FROM public.chat_participants cp
        WHERE cp.conversation_id=p_conversation_id
          AND cp.tenant_id=p_tenant_id
          AND cp.user_id=powerhub_private.current_user_id()
          AND cp.left_at IS NULL
      )
    )
    OR
    (
      private.powerhub_has_platform_capability('manageSupportChat')
      AND EXISTS (
        SELECT 1
        FROM public.chat_conversations c
        WHERE c.id=p_conversation_id
          AND c.tenant_id=p_tenant_id
          AND c.conversation_type='support'
      )
    );
$function$;
ALTER FUNCTION private.chat_rls_can_select_conversation(bigint,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_rls_can_select_conversation(bigint,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.chat_rls_can_select_conversation(bigint,bigint)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.chat_rls_can_select_participant(
  p_conversation_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_left_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    (
      p_user_id=powerhub_private.current_user_id()
      AND p_left_at IS NULL
      AND p_tenant_id=ANY(powerhub_private.current_tenant_ids())
    )
    OR
    (
      private.powerhub_has_platform_capability('manageSupportChat')
      AND EXISTS (
        SELECT 1
        FROM public.chat_conversations c
        WHERE c.id=p_conversation_id
          AND c.tenant_id=p_tenant_id
          AND c.conversation_type='support'
      )
    );
$function$;
ALTER FUNCTION private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz)
  TO authenticated;

-- Remove stray permissive policies as well as the known Staging variants.
DO $reconcile_chat_policies$
DECLARE
  v_table text;
  v_policy record;
  v_tables constant text[] := ARRAY[
    'chat_conversations','chat_participants','chat_bot_handoffs',
    'chat_message_attachments','chat_message_receipts'
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
$reconcile_chat_policies$;

CREATE POLICY chat_conversations_select_participant
ON public.chat_conversations FOR SELECT TO authenticated
USING (private.chat_rls_can_select_conversation(id,tenant_id));

CREATE POLICY chat_participants_select_self_or_support
ON public.chat_participants FOR SELECT TO authenticated
USING (
  private.chat_rls_can_select_participant(conversation_id,tenant_id,user_id,left_at)
);

CREATE POLICY chat_handoffs_select_conversation_access
ON public.chat_bot_handoffs FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.chat_participants cp
    WHERE cp.conversation_id=chat_bot_handoffs.conversation_id
      AND cp.tenant_id=chat_bot_handoffs.tenant_id
      AND cp.user_id=powerhub_private.current_user_id()
      AND cp.left_at IS NULL
  )
  OR
  (
    EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=chat_bot_handoffs.conversation_id
        AND c.tenant_id=chat_bot_handoffs.tenant_id
        AND c.conversation_type='support'
    )
    AND private.powerhub_has_platform_capability('manageSupportChat')
  )
);

CREATE POLICY chat_attachments_select_conversation_access
ON public.chat_message_attachments FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.chat_participants cp
    WHERE cp.conversation_id=chat_message_attachments.conversation_id
      AND cp.tenant_id=chat_message_attachments.tenant_id
      AND cp.user_id=powerhub_private.current_user_id()
      AND cp.left_at IS NULL
  )
  OR
  (
    EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=chat_message_attachments.conversation_id
        AND c.tenant_id=chat_message_attachments.tenant_id
        AND c.conversation_type='support'
    )
    AND private.powerhub_has_platform_capability('manageSupportChat')
  )
);

CREATE POLICY chat_message_receipts_select_access
ON public.chat_message_receipts FOR SELECT TO authenticated
USING (
  user_id=powerhub_private.current_user_id()
  OR EXISTS (
    SELECT 1 FROM public.chat_messages m
    WHERE m.id=chat_message_receipts.message_id
      AND m.sender_user_id=powerhub_private.current_user_id()
  )
  OR
  (
    EXISTS (
      SELECT 1
      FROM public.chat_messages m
      JOIN public.chat_conversations c
        ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
      WHERE m.id=chat_message_receipts.message_id
        AND c.conversation_type='support'
    )
    AND private.powerhub_has_platform_capability('manageSupportChat')
  )
);

SELECT pg_notify('pgrst','reload schema');
