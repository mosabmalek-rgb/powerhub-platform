-- Close the Staging ACL drift found in the two private chat implementations.
-- Their reviewed public RPC wrappers are SECURITY DEFINER and execute as the
-- postgres owner, so browser roles do not need direct EXECUTE on these internals.
-- This migration changes function ACLs only; it does not alter bodies, data or RLS.

DO $preflight$
DECLARE
  v_signature text;
  v_oid oid;
  v_owner text;
  v_config text[];
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'private.chat_create_conversation(bigint,text,text,text)',
    'private.chat_mark_notification_read(bigint)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'PRIVATE_CHAT_RPC_FUNCTION_MISSING: %', v_signature;
    END IF;

    SELECT pg_get_userbyid(proowner), proconfig
      INTO v_owner, v_config
    FROM pg_proc
    WHERE oid = v_oid;

    IF v_owner <> 'postgres'
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
       OR coalesce(array_to_string(v_config, ','), '') NOT LIKE '%search_path=""%' THEN
      RAISE EXCEPTION 'PRIVATE_CHAT_RPC_SECURITY_CONTEXT_MISMATCH: %', v_signature;
    END IF;
  END LOOP;

  IF to_regprocedure('public.chat_create_conversation(bigint,text,text,text)') IS NULL
     OR to_regprocedure('public.chat_mark_notification_read(bigint)') IS NULL THEN
    RAISE EXCEPTION 'PRIVATE_CHAT_RPC_PUBLIC_WRAPPER_MISSING';
  END IF;
END
$preflight$;

REVOKE ALL ON FUNCTION
  private.chat_create_conversation(bigint,text,text,text),
  private.chat_mark_notification_read(bigint)
FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_signature text;
  v_oid oid;
  v_public_wrapper oid;
  v_config text[];
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'private.chat_create_conversation(bigint,text,text,text)',
    'private.chat_mark_notification_read(bigint)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);

    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'PRIVATE_CHAT_RPC_DIRECT_EXECUTE_REMAINS: %', v_signature;
    END IF;
  END LOOP;

  v_public_wrapper := to_regprocedure('public.chat_create_conversation(bigint,text,text,text)');
  SELECT proconfig INTO v_config FROM pg_proc WHERE oid = v_public_wrapper;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_public_wrapper)
     OR coalesce(array_to_string(v_config, ','), '') NOT LIKE '%search_path=""%'
     OR has_function_privilege('anon', v_public_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public_wrapper, 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC_CHAT_CREATE_WRAPPER_CONTRACT_CHANGED';
  END IF;

  v_public_wrapper := to_regprocedure('public.chat_mark_notification_read(bigint)');
  SELECT proconfig INTO v_config FROM pg_proc WHERE oid = v_public_wrapper;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_public_wrapper)
     OR coalesce(array_to_string(v_config, ','), '') NOT LIKE '%search_path=""%'
     OR has_function_privilege('anon', v_public_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_public_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_public_wrapper, 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC_CHAT_NOTIFICATION_WRAPPER_CONTRACT_CHANGED';
  END IF;
END
$postflight$;

SELECT pg_notify('pgrst', 'reload schema');
