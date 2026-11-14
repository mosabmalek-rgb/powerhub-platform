-- Restore the reviewed public-RPC -> private-implementation boundary for chat.
-- Public browser RPCs execute as their trusted postgres owner, while private
-- implementation functions remain non-callable directly by browser/server roles.
-- Every private implementation retains its own auth.uid(), tenant, participant,
-- feature, or manageSupportChat checks; this migration does not grant EXECUTE on
-- private functions to authenticated or service_role.

DO $preflight$
DECLARE
  v_signature text;
  v_oid oid;
  v_owner text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.chat_assign_support(bigint,bigint)',
    'public.chat_create_conversation(bigint,text,text,text)',
    'public.chat_mark_delivered(bigint)',
    'public.chat_mark_notification_read(bigint)',
    'public.chat_mark_read(bigint)',
    'public.chat_mark_read_up_to(bigint,bigint)',
    'public.chat_rate_support(bigint,smallint,text)',
    'public.chat_receipts_for_message(bigint)',
    'public.chat_release_support(bigint)',
    'public.chat_reopen_support_conversation(bigint)',
    'public.chat_send_internal_note(bigint,text,uuid)',
    'public.chat_send_message(bigint,text,uuid,bigint)',
    'public.chat_set_conversation_tags(bigint,bigint[])',
    'public.chat_support_admin_save_settings(integer,integer)',
    'public.chat_support_admin_snapshot()',
    'public.chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean)',
    'public.chat_support_admin_upsert_quick_reply(text,text,text,text,boolean)',
    'public.chat_support_admin_upsert_sla(text,numeric)',
    'public.chat_support_admin_upsert_tag(text,text,text,boolean)',
    'public.chat_support_metrics(timestamptz,timestamptz)',
    'public.chat_support_queue(text,text,text,bigint,text,integer,integer)',
    'public.chat_support_set_metadata(bigint,text,text,text)',
    'public.chat_support_users()',
    'public.chat_ticket_timeline(bigint)',
    'public.chat_transition_conversation(bigint,text)',
    'public.chat_mark_all_notifications_read()',
    'public.chat_unread_notification_count()'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'CHAT_RPC_WRAPPER_MISSING: %', v_signature;
    END IF;
    SELECT pg_get_userbyid(proowner) INTO v_owner FROM pg_proc WHERE oid=v_oid;
    IF v_owner <> 'postgres' THEN
      RAISE EXCEPTION 'CHAT_RPC_WRAPPER_OWNER_MISMATCH: % owner=%', v_signature, v_owner;
    END IF;
  END LOOP;
END
$preflight$;

-- These public entry points are the only browser-callable boundary. Pin their
-- execution context and search_path without changing their existing arguments
-- or their underlying authorization logic.
ALTER FUNCTION public.chat_assign_support(bigint,bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_assign_support(bigint,bigint) SET search_path TO '';
ALTER FUNCTION public.chat_create_conversation(bigint,text,text,text) SECURITY DEFINER;
ALTER FUNCTION public.chat_create_conversation(bigint,text,text,text) SET search_path TO '';
ALTER FUNCTION public.chat_mark_delivered(bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_mark_delivered(bigint) SET search_path TO '';
ALTER FUNCTION public.chat_mark_notification_read(bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_mark_notification_read(bigint) SET search_path TO '';
ALTER FUNCTION public.chat_mark_read(bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_mark_read(bigint) SET search_path TO '';
ALTER FUNCTION public.chat_mark_read_up_to(bigint,bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_mark_read_up_to(bigint,bigint) SET search_path TO '';
ALTER FUNCTION public.chat_rate_support(bigint,smallint,text) SECURITY DEFINER;
ALTER FUNCTION public.chat_rate_support(bigint,smallint,text) SET search_path TO '';
ALTER FUNCTION public.chat_receipts_for_message(bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_receipts_for_message(bigint) SET search_path TO '';
ALTER FUNCTION public.chat_release_support(bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_release_support(bigint) SET search_path TO '';
ALTER FUNCTION public.chat_reopen_support_conversation(bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_reopen_support_conversation(bigint) SET search_path TO '';
ALTER FUNCTION public.chat_send_internal_note(bigint,text,uuid) SECURITY DEFINER;
ALTER FUNCTION public.chat_send_internal_note(bigint,text,uuid) SET search_path TO '';
ALTER FUNCTION public.chat_send_message(bigint,text,uuid,bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_send_message(bigint,text,uuid,bigint) SET search_path TO '';
ALTER FUNCTION public.chat_set_conversation_tags(bigint,bigint[]) SECURITY DEFINER;
ALTER FUNCTION public.chat_set_conversation_tags(bigint,bigint[]) SET search_path TO '';
ALTER FUNCTION public.chat_support_admin_save_settings(integer,integer) SECURITY DEFINER;
ALTER FUNCTION public.chat_support_admin_save_settings(integer,integer) SET search_path TO '';
ALTER FUNCTION public.chat_support_admin_snapshot() SECURITY DEFINER;
ALTER FUNCTION public.chat_support_admin_snapshot() SET search_path TO '';
ALTER FUNCTION public.chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean) SECURITY DEFINER;
ALTER FUNCTION public.chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean) SET search_path TO '';
ALTER FUNCTION public.chat_support_admin_upsert_quick_reply(text,text,text,text,boolean) SECURITY DEFINER;
ALTER FUNCTION public.chat_support_admin_upsert_quick_reply(text,text,text,text,boolean) SET search_path TO '';
ALTER FUNCTION public.chat_support_admin_upsert_sla(text,numeric) SECURITY DEFINER;
ALTER FUNCTION public.chat_support_admin_upsert_sla(text,numeric) SET search_path TO '';
ALTER FUNCTION public.chat_support_admin_upsert_tag(text,text,text,boolean) SECURITY DEFINER;
ALTER FUNCTION public.chat_support_admin_upsert_tag(text,text,text,boolean) SET search_path TO '';
ALTER FUNCTION public.chat_support_metrics(timestamptz,timestamptz) SECURITY DEFINER;
ALTER FUNCTION public.chat_support_metrics(timestamptz,timestamptz) SET search_path TO '';
ALTER FUNCTION public.chat_support_queue(text,text,text,bigint,text,integer,integer) SECURITY DEFINER;
ALTER FUNCTION public.chat_support_queue(text,text,text,bigint,text,integer,integer) SET search_path TO '';
ALTER FUNCTION public.chat_support_set_metadata(bigint,text,text,text) SECURITY DEFINER;
ALTER FUNCTION public.chat_support_set_metadata(bigint,text,text,text) SET search_path TO '';
ALTER FUNCTION public.chat_support_users() SECURITY DEFINER;
ALTER FUNCTION public.chat_support_users() SET search_path TO '';
ALTER FUNCTION public.chat_ticket_timeline(bigint) SECURITY DEFINER;
ALTER FUNCTION public.chat_ticket_timeline(bigint) SET search_path TO '';
ALTER FUNCTION public.chat_transition_conversation(bigint,text) SECURITY DEFINER;
ALTER FUNCTION public.chat_transition_conversation(bigint,text) SET search_path TO '';
ALTER FUNCTION public.chat_mark_all_notifications_read() SECURITY DEFINER;
ALTER FUNCTION public.chat_mark_all_notifications_read() SET search_path TO '';
ALTER FUNCTION public.chat_unread_notification_count() SECURITY DEFINER;
ALTER FUNCTION public.chat_unread_notification_count() SET search_path TO '';

-- Keep the private implementation layer private. In particular, remove three
-- Staging-only grants that had made selected internals directly callable.
REVOKE ALL ON FUNCTION
  private.chat_assign_support(bigint,bigint),
  private.chat_create_conversation(bigint,text,text,text),
  private.chat_mark_delivered(bigint),
  private.chat_mark_notification_read(bigint),
  private.chat_mark_read(bigint),
  private.chat_mark_read_up_to(bigint,bigint),
  private.chat_rate_support(bigint,smallint,text),
  private.chat_reopen_support_conversation(bigint),
  private.chat_release_support(bigint),
  private.chat_send_internal_note(bigint,text,uuid),
  private.chat_send_message(bigint,text,uuid,bigint),
  private.chat_set_conversation_tags(bigint,bigint[]),
  private.chat_support_metrics(timestamptz,timestamptz),
  private.chat_support_queue(text,text,text,bigint,text,integer,integer),
  private.chat_support_set_metadata(bigint,text,text,text),
  private.chat_support_users(),
  private.chat_ticket_timeline(bigint),
  private.chat_transition_conversation(bigint,text),
  private.chat_assert_support_admin(),
  private.chat_current_user_id(),
  private.chat_mark_all_notifications_read(),
  private.chat_unread_notification_count()
FROM PUBLIC, anon, authenticated, service_role;

-- Explicitly allow only authenticated browser calls and trusted service calls
-- to the public wrappers. Anonymous and PUBLIC execution stays denied.
REVOKE ALL ON FUNCTION
  public.chat_assign_support(bigint,bigint),
  public.chat_create_conversation(bigint,text,text,text),
  public.chat_mark_delivered(bigint),
  public.chat_mark_notification_read(bigint),
  public.chat_mark_read(bigint),
  public.chat_mark_read_up_to(bigint,bigint),
  public.chat_rate_support(bigint,smallint,text),
  public.chat_receipts_for_message(bigint),
  public.chat_release_support(bigint),
  public.chat_reopen_support_conversation(bigint),
  public.chat_send_internal_note(bigint,text,uuid),
  public.chat_send_message(bigint,text,uuid,bigint),
  public.chat_set_conversation_tags(bigint,bigint[]),
  public.chat_support_admin_save_settings(integer,integer),
  public.chat_support_admin_snapshot(),
  public.chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean),
  public.chat_support_admin_upsert_quick_reply(text,text,text,text,boolean),
  public.chat_support_admin_upsert_sla(text,numeric),
  public.chat_support_admin_upsert_tag(text,text,text,boolean),
  public.chat_support_metrics(timestamptz,timestamptz),
  public.chat_support_queue(text,text,text,bigint,text,integer,integer),
  public.chat_support_set_metadata(bigint,text,text,text),
  public.chat_support_users(),
  public.chat_ticket_timeline(bigint),
  public.chat_transition_conversation(bigint,text),
  public.chat_mark_all_notifications_read(),
  public.chat_unread_notification_count()
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.chat_assign_support(bigint,bigint),
  public.chat_create_conversation(bigint,text,text,text),
  public.chat_mark_delivered(bigint),
  public.chat_mark_notification_read(bigint),
  public.chat_mark_read(bigint),
  public.chat_mark_read_up_to(bigint,bigint),
  public.chat_rate_support(bigint,smallint,text),
  public.chat_receipts_for_message(bigint),
  public.chat_release_support(bigint),
  public.chat_reopen_support_conversation(bigint),
  public.chat_send_internal_note(bigint,text,uuid),
  public.chat_send_message(bigint,text,uuid,bigint),
  public.chat_set_conversation_tags(bigint,bigint[]),
  public.chat_support_admin_save_settings(integer,integer),
  public.chat_support_admin_snapshot(),
  public.chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean),
  public.chat_support_admin_upsert_quick_reply(text,text,text,text,boolean),
  public.chat_support_admin_upsert_sla(text,numeric),
  public.chat_support_admin_upsert_tag(text,text,text,boolean),
  public.chat_support_metrics(timestamptz,timestamptz),
  public.chat_support_queue(text,text,text,bigint,text,integer,integer),
  public.chat_support_set_metadata(bigint,text,text,text),
  public.chat_support_users(),
  public.chat_ticket_timeline(bigint),
  public.chat_transition_conversation(bigint,text),
  public.chat_mark_all_notifications_read(),
  public.chat_unread_notification_count()
TO authenticated, service_role;

DO $postflight$
DECLARE
  v_signature text;
  v_oid oid;
  v_owner text;
  v_config text[];
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.chat_assign_support(bigint,bigint)',
    'public.chat_create_conversation(bigint,text,text,text)',
    'public.chat_mark_delivered(bigint)',
    'public.chat_mark_notification_read(bigint)',
    'public.chat_mark_read(bigint)',
    'public.chat_mark_read_up_to(bigint,bigint)',
    'public.chat_rate_support(bigint,smallint,text)',
    'public.chat_receipts_for_message(bigint)',
    'public.chat_release_support(bigint)',
    'public.chat_reopen_support_conversation(bigint)',
    'public.chat_send_internal_note(bigint,text,uuid)',
    'public.chat_send_message(bigint,text,uuid,bigint)',
    'public.chat_set_conversation_tags(bigint,bigint[])',
    'public.chat_support_admin_save_settings(integer,integer)',
    'public.chat_support_admin_snapshot()',
    'public.chat_support_admin_upsert_category(text,text,text,integer,integer,integer,boolean)',
    'public.chat_support_admin_upsert_quick_reply(text,text,text,text,boolean)',
    'public.chat_support_admin_upsert_sla(text,numeric)',
    'public.chat_support_admin_upsert_tag(text,text,text,boolean)',
    'public.chat_support_metrics(timestamptz,timestamptz)',
    'public.chat_support_queue(text,text,text,bigint,text,integer,integer)',
    'public.chat_support_set_metadata(bigint,text,text,text)',
    'public.chat_support_users()',
    'public.chat_ticket_timeline(bigint)',
    'public.chat_transition_conversation(bigint,text)',
    'public.chat_mark_all_notifications_read()',
    'public.chat_unread_notification_count()'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    SELECT proowner,proconfig INTO STRICT v_owner,v_config FROM pg_proc WHERE oid=v_oid;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
       OR coalesce(array_to_string(v_config,','),'') NOT LIKE '%search_path=""%' THEN
      RAISE EXCEPTION 'CHAT_RPC_WRAPPER_SECURITY_CONTEXT_MISMATCH: %', v_signature;
    END IF;
    IF has_function_privilege('anon',v_oid,'EXECUTE')
       OR NOT has_function_privilege('authenticated',v_oid,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
      RAISE EXCEPTION 'CHAT_RPC_WRAPPER_ACL_MISMATCH: %', v_signature;
    END IF;
  END LOOP;

  IF has_function_privilege('authenticated','private.chat_send_message(bigint,text,uuid,bigint)','EXECUTE')
     OR has_function_privilege('service_role','private.chat_send_message(bigint,text,uuid,bigint)','EXECUTE')
     OR has_function_privilege('anon','private.chat_send_message(bigint,text,uuid,bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_PRIVATE_IMPLEMENTATION_IS_CALLABLE';
  END IF;
END
$postflight$;

SELECT pg_notify('pgrst','reload schema');
