-- Close remaining disabled-account RLS and internal-note delivery gaps.
-- Support Center access remains limited to support conversations; tenant
-- participants retain active membership and feature-policy checks.
DO $preflight$
BEGIN
  IF to_regprocedure('private.chat_mark_delivered(bigint)') IS NULL
     OR to_regprocedure('private.chat_rls_can_select_conversation(bigint,bigint)') IS NULL
     OR to_regprocedure('private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz)') IS NULL
     OR to_regprocedure('private.chat_current_user_id()') IS NULL
     OR to_regprocedure('private.chat_can_access_conversation(bigint)') IS NULL
     OR to_regprocedure('private.powerhub_has_platform_capability(text)') IS NULL
     OR to_regprocedure('powerhub_private.current_tenant_ids()') IS NULL
     OR to_regprocedure('private.chat_feature_enabled_for_tenant(bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'CHAT_RLS_ACTIVE_ACCOUNT_DEPENDENCY_MISSING';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION private.chat_mark_delivered(p_message_id bigint)
 RETURNS chat_message_receipts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id bigint; v_receipt public.chat_message_receipts; v_msg public.chat_messages;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;
  select * into v_msg from public.chat_messages where id=p_message_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not private.chat_can_access_conversation(v_msg.conversation_id)
     or (v_msg.visibility='internal' and not private.powerhub_has_platform_capability('manageSupportChat')) then
    raise exception 'FORBIDDEN';
  end if;
  if v_msg.sender_user_id = v_user_id then raise exception 'INVALID_RECIPIENT'; end if;
  insert into public.chat_message_receipts(tenant_id,conversation_id,message_id,user_id,delivered_at)
  values(v_msg.tenant_id,v_msg.conversation_id,v_msg.id,v_user_id,now())
  on conflict (message_id,user_id) do update set delivered_at=coalesce(public.chat_message_receipts.delivered_at,excluded.delivered_at), updated_at=now()
  returning * into v_receipt;
  return v_receipt;
end;
$function$
;
CREATE OR REPLACE FUNCTION private.chat_rls_can_select_conversation(p_conversation_id bigint, p_tenant_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=p_conversation_id AND c.tenant_id=p_tenant_id
      AND private.chat_current_user_id() IS NOT NULL
      AND (
        (
          p_tenant_id=ANY(powerhub_private.current_tenant_ids())
          AND EXISTS (
            SELECT 1 FROM public.chat_participants cp
            WHERE cp.conversation_id=c.id AND cp.tenant_id=c.tenant_id
              AND cp.user_id=powerhub_private.current_user_id() AND cp.left_at IS NULL
          )
          AND private.chat_feature_enabled_for_tenant(c.tenant_id,c.conversation_type)
        )
        OR (c.conversation_type='support' AND private.powerhub_has_platform_capability('manageSupportChat'))
      )
  );
$function$
;
CREATE OR REPLACE FUNCTION private.chat_rls_can_select_participant(p_conversation_id bigint, p_tenant_id bigint, p_user_id bigint, p_left_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=p_conversation_id AND c.tenant_id=p_tenant_id
      AND private.chat_current_user_id() IS NOT NULL
      AND (
        (
          p_user_id=powerhub_private.current_user_id() AND p_left_at IS NULL
          AND p_tenant_id=ANY(powerhub_private.current_tenant_ids())
          AND private.chat_feature_enabled_for_tenant(c.tenant_id,c.conversation_type)
        )
        OR (c.conversation_type='support' AND private.powerhub_has_platform_capability('manageSupportChat'))
      )
  );
$function$
;

DO $postflight$
DECLARE v_oid oid;
BEGIN
  v_oid := to_regprocedure('private.chat_mark_delivered(bigint)');
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
     OR has_function_privilege('anon',v_oid,'EXECUTE')
     OR has_function_privilege('authenticated',v_oid,'EXECUTE')
     OR has_function_privilege('service_role',v_oid,'EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_MARK_DELIVERED_PRIVATE_BOUNDARY_MISMATCH';
  END IF;
  v_oid := to_regprocedure('private.chat_rls_can_select_conversation(bigint,bigint)');
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
     OR has_function_privilege('anon',v_oid,'EXECUTE')
     OR NOT has_function_privilege('authenticated',v_oid,'EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_RLS_CONVERSATION_HELPER_ACL_MISMATCH';
  END IF;
  v_oid := to_regprocedure('private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz)');
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
     OR has_function_privilege('anon',v_oid,'EXECUTE')
     OR NOT has_function_privilege('authenticated',v_oid,'EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_RLS_PARTICIPANT_HELPER_ACL_MISMATCH';
  END IF;
END
$postflight$;
SELECT pg_notify('pgrst','reload schema');
