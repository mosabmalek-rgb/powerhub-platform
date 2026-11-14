-- Restrict public-message receipt visibility to the sender, the receipt owner,
-- or an authorized Support Center operator. Keep internal-note receipts
-- restricted to Support Center operators on support conversations only.

DO $preflight$
BEGIN
  IF to_regprocedure('public.chat_receipts_for_message(bigint)') IS NULL
     OR to_regprocedure('private.chat_current_user_id()') IS NULL
     OR to_regprocedure('private.chat_can_access_conversation(bigint)') IS NULL
     OR to_regprocedure('private.powerhub_has_platform_capability(text)') IS NULL THEN
    RAISE EXCEPTION 'CHAT_RECEIPT_PRIVACY_DEPENDENCY_MISSING';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.chat_receipts_for_message(p_message_id bigint)
 RETURNS SETOF public.chat_message_receipts
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select r.*
  from public.chat_message_receipts r
  join public.chat_messages m
    on m.id = r.message_id
  join public.chat_conversations c
    on c.id = m.conversation_id
   and c.tenant_id = m.tenant_id
  where r.message_id = p_message_id
    and exists (
      select 1 from public.users u
      where u.auth_user_id=auth.uid() and u.account_status='active'
    )
    and (
      (
        m.visibility = 'public'
        and private.chat_can_access_conversation(c.id)
        and (
          r.user_id = private.chat_current_user_id()
          or m.sender_user_id = private.chat_current_user_id()
          or (
            c.conversation_type = 'support'
            and private.powerhub_has_platform_capability('manageSupportChat')
          )
        )
      )
      or (
        m.visibility = 'internal'
        and c.conversation_type = 'support'
        and private.powerhub_has_platform_capability('manageSupportChat')
      )
    );
$function$;

DO $postflight$
DECLARE
  v_oid oid := to_regprocedure('public.chat_receipts_for_message(bigint)');
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
     OR coalesce((SELECT array_to_string(proconfig,',') FROM pg_proc WHERE oid=v_oid),'') NOT LIKE '%search_path=""%' THEN
    RAISE EXCEPTION 'CHAT_RECEIPT_PRIVACY_SECURITY_CONTEXT_MISMATCH';
  END IF;
  IF has_function_privilege('anon',v_oid,'EXECUTE')
     OR NOT has_function_privilege('authenticated',v_oid,'EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_RECEIPT_PRIVACY_ACL_MISMATCH';
  END IF;
END
$postflight$;

SELECT pg_notify('pgrst','reload schema');
