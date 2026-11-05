-- Private trigger functions are called by PostgreSQL as part of trigger
-- execution; callers do not need direct EXECUTE privileges on them.
-- Remove unnecessary PUBLIC/browser/service-role grants while preserving the
-- trigger objects and the fixed SECURITY DEFINER execution context.
DO $preflight$
DECLARE
  v_oid oid;
  v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'private.chat_after_support_conversation_create()',
    'private.chat_notify_message_visibility()',
    'private.chat_prepare_support_conversation()'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL
       OR (SELECT prorettype FROM pg_proc WHERE oid=v_oid) <> 'trigger'::regtype
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
       OR coalesce((SELECT array_to_string(proconfig,',') FROM pg_proc WHERE oid=v_oid),'') NOT LIKE '%search_path=""%' THEN
      RAISE EXCEPTION 'CHAT_TRIGGER_FUNCTION_PREFLIGHT_FAILED: %',v_signature;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='chat_after_support_conversation_create_trigger'
      AND tgfoid='private.chat_after_support_conversation_create()'::regprocedure
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='chat_prepare_support_conversation_before_insert'
      AND tgfoid='private.chat_prepare_support_conversation()'::regprocedure
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'CHAT_TRIGGER_ATTACHMENT_MISSING';
  END IF;
END
$preflight$;

REVOKE ALL ON FUNCTION private.chat_after_support_conversation_create()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.chat_notify_message_visibility()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.chat_prepare_support_conversation()
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_oid oid;
  v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'private.chat_after_support_conversation_create()',
    'private.chat_notify_message_visibility()',
    'private.chat_prepare_support_conversation()'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF has_function_privilege('anon',v_oid,'EXECUTE')
       OR has_function_privilege('authenticated',v_oid,'EXECUTE')
       OR has_function_privilege('service_role',v_oid,'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid=v_oid),
           acldefault('f',(SELECT proowner FROM pg_proc WHERE oid=v_oid))
         )) a
         WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
       ) THEN
      RAISE EXCEPTION 'CHAT_TRIGGER_FUNCTION_EXECUTE_GRANT_REMAINS: %',v_signature;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='chat_after_support_conversation_create_trigger'
      AND tgfoid='private.chat_after_support_conversation_create()'::regprocedure
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='chat_prepare_support_conversation_before_insert'
      AND tgfoid='private.chat_prepare_support_conversation()'::regprocedure
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'CHAT_TRIGGER_ATTACHMENT_CHANGED';
  END IF;
END
$postflight$;
