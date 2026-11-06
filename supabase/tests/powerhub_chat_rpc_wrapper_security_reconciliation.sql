\set ON_ERROR_STOP on

DO $roles$
BEGIN
  BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO postgres;

-- Minimal function fixtures preserve the production signatures. The fake
-- implementation returns its SECURITY DEFINER execution identity; this test
-- exercises PostgreSQL's nested-function ACL boundary, not chat business data.
DO $fixtures$
DECLARE
  v record;
  v_body text;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('chat_assign_support','bigint,bigint','$1,$2'),
      ('chat_create_conversation','bigint,text,text,text','$1,$2,$3,$4'),
      ('chat_mark_delivered','bigint','$1'),
      ('chat_mark_notification_read','bigint','$1'),
      ('chat_mark_read','bigint','$1'),
      ('chat_mark_read_up_to','bigint,bigint','$1,$2'),
      ('chat_rate_support','bigint,smallint,text','$1,$2,$3'),
      ('chat_release_support','bigint','$1'),
      ('chat_reopen_support_conversation','bigint','$1'),
      ('chat_send_internal_note','bigint,text,uuid','$1,$2,$3'),
      ('chat_send_message','bigint,text,uuid,bigint','$1,$2,$3,$4'),
      ('chat_set_conversation_tags','bigint,bigint[]','$1,$2'),
      ('chat_support_metrics','timestamptz,timestamptz','$1,$2'),
      ('chat_support_queue','text,text,text,bigint,text,integer,integer','$1,$2,$3,$4,$5,$6,$7'),
      ('chat_support_set_metadata','bigint,text,text,text','$1,$2,$3,$4'),
      ('chat_support_users','',''),
      ('chat_ticket_timeline','bigint','$1'),
      ('chat_transition_conversation','bigint,text','$1,$2'),
      ('chat_mark_all_notifications_read','',''),
      ('chat_unread_notification_count','','')
    ) AS s(name,arg_types,call_args)
  LOOP
    EXECUTE format(
      'CREATE FUNCTION private.%I(%s) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO %L AS %L',
      v.name,v.arg_types,'','SELECT current_user::text'
    );
    v_body := format('SELECT private.%I(%s)',v.name,v.call_args);
    EXECUTE format(
      'CREATE FUNCTION public.%I(%s) RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path TO %L AS %L',
      v.name,v.arg_types,'',v_body
    );
  END LOOP;

  EXECUTE $ddl$CREATE FUNCTION private.chat_assert_support_admin()
    RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO ''
    AS $function$ SELECT current_user::text $function$$ddl$;
  EXECUTE $ddl$CREATE FUNCTION private.chat_current_user_id()
    RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO ''
    AS $function$ SELECT current_user::text $function$$ddl$;

  FOR v IN
    SELECT * FROM (VALUES
      ('chat_support_admin_save_settings','integer,integer','SELECT private.chat_assert_support_admin()'),
      ('chat_support_admin_snapshot','','SELECT private.chat_assert_support_admin()'),
      ('chat_support_admin_upsert_category','text,text,text,integer,integer,integer,boolean','SELECT private.chat_assert_support_admin()'),
      ('chat_support_admin_upsert_quick_reply','text,text,text,text,boolean','SELECT private.chat_assert_support_admin()'),
      ('chat_support_admin_upsert_sla','text,numeric','SELECT private.chat_assert_support_admin()'),
      ('chat_support_admin_upsert_tag','text,text,text,boolean','SELECT private.chat_assert_support_admin()'),
      ('chat_receipts_for_message','bigint','SELECT private.chat_current_user_id()')
    ) AS s(name,arg_types,body)
  LOOP
    EXECUTE format(
      'CREATE FUNCTION public.%I(%s) RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path TO %L AS %L',
      v.name,v.arg_types,'',v.body
    );
  END LOOP;

  -- Mirror the public RPC ACLs that exist on Staging before the forward fix.
  FOR v IN
    SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'chat_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC,anon',v.proname,v.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated,service_role',v.proname,v.args);
  END LOOP;

  -- Private functions are not directly browser-callable.
  FOR v IN
    SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='private' AND p.proname LIKE 'chat_%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION private.%I(%s) FROM PUBLIC,anon,authenticated,service_role',v.proname,v.args);
  END LOOP;
END
$fixtures$;

-- Trigger-only functions retain trigger execution after browser-facing EXECUTE
-- grants are revoked. PostgreSQL does not require table callers to hold EXECUTE
-- on an attached trigger function.
CREATE TABLE public.chat_conversations (
  id bigint primary key,
  prepared_by_trigger boolean not null default false,
  post_insert_trigger_fired boolean not null default false
);
GRANT USAGE ON SCHEMA private TO anon,authenticated;

CREATE FUNCTION private.chat_after_support_conversation_create()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.chat_conversations
  SET post_insert_trigger_fired=true
  WHERE id=NEW.id;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION private.chat_notify_message_visibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE FUNCTION private.chat_prepare_support_conversation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  NEW.prepared_by_trigger:=true;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER chat_prepare_support_conversation_before_insert
BEFORE INSERT ON public.chat_conversations
FOR EACH ROW EXECUTE FUNCTION private.chat_prepare_support_conversation();

CREATE TRIGGER chat_after_support_conversation_create_trigger
AFTER INSERT ON public.chat_conversations
FOR EACH ROW EXECUTE FUNCTION private.chat_after_support_conversation_create();

GRANT EXECUTE ON FUNCTION
  private.chat_after_support_conversation_create(),
  private.chat_notify_message_visibility(),
  private.chat_prepare_support_conversation()
TO PUBLIC,anon,authenticated,service_role;

DO $trigger_grants_before$
BEGIN
  IF NOT has_function_privilege('anon','private.chat_after_support_conversation_create()','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.chat_notify_message_visibility()','EXECUTE')
     OR NOT has_function_privilege('service_role','private.chat_prepare_support_conversation()','EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_TRIGGER_EXECUTE_GRANT_FIXTURE_MISSING';
  END IF;
END
$trigger_grants_before$;

\ir ../migrations/20261101225044_powerhub_chat_rpc_wrapper_security_reconciliation.sql
\ir ../migrations/20261105150631_powerhub_chat_trigger_function_exec_revoke.sql

-- Reproduce the two direct private-function grants observed on Staging
-- after the original wrapper reconciliation. The forward migration below
-- must remove them without breaking public SECURITY DEFINER wrappers.
GRANT EXECUTE ON FUNCTION
  private.chat_create_conversation(bigint,text,text,text),
  private.chat_mark_notification_read(bigint)
TO authenticated;

\ir ../migrations/20261106155820_powerhub_private_chat_rpc_acl_reconciliation.sql


DO $assert_acl$
DECLARE
  v_signature text;
  v_oid oid;
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
    v_oid:=to_regprocedure(v_signature);
    IF v_oid IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid) THEN
      RAISE EXCEPTION 'PUBLIC_CHAT_RPC_NOT_SECURITY_DEFINER: %',v_signature;
    END IF;
    IF coalesce(array_to_string((SELECT proconfig FROM pg_proc WHERE oid=v_oid),','),'') NOT LIKE '%search_path=""%' THEN
      RAISE EXCEPTION 'PUBLIC_CHAT_RPC_SEARCH_PATH_NOT_PINNED: %',v_signature;
    END IF;
    IF has_function_privilege('anon',v_oid,'EXECUTE')
       OR NOT has_function_privilege('authenticated',v_oid,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC_CHAT_RPC_ACL_MISMATCH: %',v_signature;
    END IF;
  END LOOP;

  IF has_function_privilege('authenticated','private.chat_send_message(bigint,text,uuid,bigint)','EXECUTE')
     OR has_function_privilege('service_role','private.chat_send_message(bigint,text,uuid,bigint)','EXECUTE')
     OR has_function_privilege('anon','private.chat_send_message(bigint,text,uuid,bigint)','EXECUTE')
     OR has_function_privilege('authenticated','private.chat_assert_support_admin()','EXECUTE') THEN
    RAISE EXCEPTION 'PRIVATE_CHAT_IMPLEMENTATION_EXECUTE_GRANT_REMAINS';
  END IF;
END
$assert_acl$;

-- The outer authenticated role must be able to use each reviewed public RPC,
-- even though direct calls to its private implementation remain denied.
SET ROLE authenticated;
DO $authenticated_runtime$
DECLARE
  v record;
  v_result text;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('chat_assign_support','SELECT public.chat_assign_support(1,2)'),
      ('chat_create_conversation','SELECT public.chat_create_conversation(10,''assistant'',NULL,''normal'')'),
      ('chat_mark_delivered','SELECT public.chat_mark_delivered(100)'),
      ('chat_mark_notification_read','SELECT public.chat_mark_notification_read(1)'),
      ('chat_mark_read','SELECT public.chat_mark_read(100)'),
      ('chat_mark_read_up_to','SELECT public.chat_mark_read_up_to(1,100)'),
      ('chat_rate_support','SELECT public.chat_rate_support(1::bigint,5::smallint,NULL::text)'),
      ('chat_receipts_for_message','SELECT public.chat_receipts_for_message(100)'),
      ('chat_release_support','SELECT public.chat_release_support(1)'),
      ('chat_reopen_support_conversation','SELECT public.chat_reopen_support_conversation(1)'),
      ('chat_send_internal_note','SELECT public.chat_send_internal_note(1,''note'',''11111111-1111-4111-8111-111111111111'')'),
      ('chat_send_message','SELECT public.chat_send_message(1,''body'',''11111111-1111-4111-8111-111111111111'',NULL)'),
      ('chat_set_conversation_tags','SELECT public.chat_set_conversation_tags(1,ARRAY[1]::bigint[])'),
      ('chat_support_admin_save_settings','SELECT public.chat_support_admin_save_settings(1,60)'),
      ('chat_support_admin_snapshot','SELECT public.chat_support_admin_snapshot()'),
      ('chat_support_admin_upsert_category','SELECT public.chat_support_admin_upsert_category(''general'',''General'',NULL,5,30,1,true)'),
      ('chat_support_admin_upsert_quick_reply','SELECT public.chat_support_admin_upsert_quick_reply(''hello'',''Hello'',''Hi'',NULL,true)'),
      ('chat_support_admin_upsert_sla','SELECT public.chat_support_admin_upsert_sla(''normal'',1.0)'),
      ('chat_support_admin_upsert_tag','SELECT public.chat_support_admin_upsert_tag(''tag'',''Tag'',''#777777'',true)'),
      ('chat_support_metrics','SELECT public.chat_support_metrics(now()-interval ''1 day'',now())'),
      ('chat_support_queue','SELECT public.chat_support_queue(NULL,NULL,NULL,NULL,NULL,50,0)'),
      ('chat_support_set_metadata','SELECT public.chat_support_set_metadata(1,NULL,NULL,NULL)'),
      ('chat_support_users','SELECT public.chat_support_users()'),
      ('chat_ticket_timeline','SELECT public.chat_ticket_timeline(1)'),
      ('chat_transition_conversation','SELECT public.chat_transition_conversation(1,''SUPPORT_ACTIVE'')'),
      ('chat_mark_all_notifications_read','SELECT public.chat_mark_all_notifications_read()'),
      ('chat_unread_notification_count','SELECT public.chat_unread_notification_count()')
    ) AS calls(name,sql)
  LOOP
    EXECUTE v.sql INTO v_result;
    IF v_result IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'PUBLIC_CHAT_RPC_WRAPPER_CALL_FAILED: % returned %',v.name,v_result;
    END IF;
  END LOOP;

  BEGIN
    EXECUTE 'SELECT private.chat_send_message(1,''body'',''11111111-1111-4111-8111-111111111111'',NULL)';
    RAISE EXCEPTION 'PRIVATE_CHAT_SEND_MESSAGE_WAS_DIRECTLY_CALLABLE';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    EXECUTE 'SELECT private.chat_assert_support_admin()';
    RAISE EXCEPTION 'PRIVATE_CHAT_SUPPORT_ASSERT_WAS_DIRECTLY_CALLABLE';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$authenticated_runtime$;
RESET ROLE;

SET ROLE anon;
DO $anonymous_runtime$
BEGIN
  BEGIN
    EXECUTE 'SELECT public.chat_send_message(1,''body'',''11111111-1111-4111-8111-111111111111'',NULL)';
    RAISE EXCEPTION 'ANONYMOUS_CHAT_RPC_WAS_ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$anonymous_runtime$;
RESET ROLE;

DO $trigger_exec_revoked$
DECLARE
  v_oid oid;
  v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'private.chat_after_support_conversation_create()',
    'private.chat_notify_message_visibility()',
    'private.chat_prepare_support_conversation()'
  ] LOOP
    v_oid:=to_regprocedure(v_signature);
    IF v_oid IS NULL
       OR has_function_privilege('anon',v_oid,'EXECUTE')
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
      RAISE EXCEPTION 'CHAT_TRIGGER_FUNCTION_EXECUTE_NOT_REVOKED: %',v_signature;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='chat_prepare_support_conversation_before_insert'
      AND tgfoid='private.chat_prepare_support_conversation()'::regprocedure
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='chat_after_support_conversation_create_trigger'
      AND tgfoid='private.chat_after_support_conversation_create()'::regprocedure
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'CHAT_TRIGGER_FUNCTION_ATTACHMENT_LOST';
  END IF;
END
$trigger_exec_revoked$;

INSERT INTO public.chat_conversations(id) VALUES(1);
DO $trigger_runtime_preserved$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_conversations
    WHERE id=1 AND prepared_by_trigger=true AND post_insert_trigger_fired=true
  ) THEN
    RAISE EXCEPTION 'CHAT_TRIGGER_RUNTIME_BROKEN_AFTER_EXECUTE_REVOKE';
  END IF;
END
$trigger_runtime_preserved$;

SELECT 'POWERHUB_CHAT_RPC_WRAPPER_SECURITY_ASSERTIONS_PASSED' AS result;
