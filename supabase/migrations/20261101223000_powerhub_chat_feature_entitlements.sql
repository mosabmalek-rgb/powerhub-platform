-- Tenant-scoped entitlement enforcement for Support Chat and PowerHub AI.
-- Existing conversations/messages are retained. Disabling a feature blocks access
-- and new operations; it does not delete or rewrite chat history.
DO $preflight$
BEGIN
  IF to_regprocedure('public.powerhub_resolve_tenant_feature_policy(bigint,text)') IS NULL
     OR to_regprocedure('powerhub_private.current_tenant_ids()') IS NULL
     OR to_regprocedure('powerhub_private.current_user_id()') IS NULL
     OR to_regprocedure('private.chat_current_user_id()') IS NULL
     OR to_regprocedure('private.powerhub_has_platform_capability(text)') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_FEATURE_PREREQUISITES_MISSING';
  END IF;
  IF to_regclass('public.feature_catalog') IS NULL
     OR to_regclass('public.package_feature_policies') IS NULL
     OR to_regclass('public.tenant_feature_controls') IS NULL
     OR to_regclass('public.chat_conversations') IS NULL
     OR to_regclass('public.chat_participants') IS NULL
     OR to_regclass('public.chat_messages') IS NULL
     OR to_regclass('public.chat_inbox_notifications') IS NULL
     OR to_regclass('public.chat_message_attachments') IS NULL
     OR to_regclass('public.chat_message_receipts') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_FEATURE_TABLES_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.chat_conversations'::regclass AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.chat_messages'::regclass AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.chat_message_attachments'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_FEATURE_RLS_DISABLED';
  END IF;
END
$preflight$;

-- Optional entitlements for every current package. "addon" means eligible for
-- explicit admin enablement; it does not create a billable order or charge.
INSERT INTO public.feature_catalog
  (feature_key,name,description,category,feature_type,limit_type,enforcement_mode,is_active,sort_order)
VALUES
  ('support_chat','الدردشة والدعم','محادثات الدعم المباشر لصاحب المولد وفريقه','المراسلات','capability','none','server',true,160),
  ('powerhub_ai_assistant','مساعد PowerHub الذكي','المساعد الذكي للإجابة عن أسئلة استخدام PowerHub','المراسلات','capability','none','server',true,170)
ON CONFLICT (feature_key) DO UPDATE SET
  name=EXCLUDED.name,description=EXCLUDED.description,category=EXCLUDED.category,
  feature_type='capability',limit_type='none',enforcement_mode='server',
  sort_order=EXCLUDED.sort_order,updated_at=now();

INSERT INTO public.package_feature_policies
  (package_code,feature_key,policy,default_limit,limit_mode,source)
SELECT p.package_code,f.feature_key,'addon',NULL,'unlimited','catalog'
FROM (VALUES ('basic'),('professional'),('business'),('advanced'),('vip')) AS p(package_code)
CROSS JOIN (VALUES ('support_chat'),('powerhub_ai_assistant')) AS f(feature_key)
ON CONFLICT (package_code,feature_key) DO NOTHING;

-- Return inactive catalogue rows too, so an administrator can re-enable a
-- globally disabled feature instead of making it disappear from the control UI.
CREATE OR REPLACE FUNCTION public.powerhub_admin_feature_catalog()
RETURNS TABLE(
  feature_key text,name text,description text,category text,feature_type text,
  limit_type text,enforcement_mode text,is_active boolean,sort_order integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
  SELECT feature_key,name,description,category,feature_type,limit_type,enforcement_mode,is_active,sort_order
  FROM public.feature_catalog
  ORDER BY sort_order,feature_key;
$function$;
ALTER FUNCTION public.powerhub_admin_feature_catalog() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_feature_catalog() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_feature_catalog() TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_guard_tenant_feature_control_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_catalog
    WHERE feature_key=NEW.feature_key
      AND (feature_type IN ('quota','addon','hybrid')
        OR feature_key IN ('support_chat','powerhub_ai_assistant'))
  ) THEN
    RAISE EXCEPTION 'FEATURE_NOT_TENANT_CONTROLLABLE' USING errcode='P0001';
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.powerhub_guard_tenant_feature_control_scope() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_guard_tenant_feature_control_scope() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_guard_tenant_feature_control_scope() TO service_role;

CREATE OR REPLACE FUNCTION private.chat_feature_enabled_for_tenant(p_tenant_id bigint,p_conversation_type text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $function$
DECLARE v_feature_key text; v_enabled boolean;
BEGIN
  v_feature_key := CASE p_conversation_type WHEN 'support' THEN 'support_chat' WHEN 'assistant' THEN 'powerhub_ai_assistant' ELSE NULL END;
  IF p_tenant_id IS NULL OR v_feature_key IS NULL THEN RETURN false; END IF;
  SELECT resolved.enabled INTO v_enabled
  FROM public.powerhub_resolve_tenant_feature_policy(p_tenant_id,v_feature_key) AS resolved;
  RETURN coalesce(v_enabled,false);
END;
$function$;
ALTER FUNCTION private.chat_feature_enabled_for_tenant(bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_feature_enabled_for_tenant(bigint,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.chat_rls_can_select_conversation(p_conversation_id bigint,p_tenant_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=p_conversation_id AND c.tenant_id=p_tenant_id
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
$function$;
ALTER FUNCTION private.chat_rls_can_select_conversation(bigint,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_rls_can_select_conversation(bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.chat_rls_can_select_conversation(bigint,bigint) TO authenticated;

CREATE OR REPLACE FUNCTION private.chat_rls_can_select_participant(p_conversation_id bigint,p_tenant_id bigint,p_user_id bigint,p_left_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=p_conversation_id AND c.tenant_id=p_tenant_id
      AND (
        (
          p_user_id=powerhub_private.current_user_id() AND p_left_at IS NULL
          AND p_tenant_id=ANY(powerhub_private.current_tenant_ids())
          AND private.chat_feature_enabled_for_tenant(c.tenant_id,c.conversation_type)
        )
        OR (c.conversation_type='support' AND private.powerhub_has_platform_capability('manageSupportChat'))
      )
  );
$function$;
ALTER FUNCTION private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION private.chat_can_access_conversation(p_conversation_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=p_conversation_id
      AND (
        (
          EXISTS (
            SELECT 1 FROM public.chat_participants cp
            JOIN public.tenant_members tm ON tm.tenant_id=c.tenant_id AND tm.user_id=cp.user_id
            WHERE cp.conversation_id=c.id AND cp.tenant_id=c.tenant_id
              AND cp.user_id=private.chat_current_user_id() AND cp.left_at IS NULL
              AND tm.is_active=true AND tm.membership_status='active'
              AND (tm.expires_at IS NULL OR tm.expires_at>now())
          )
          AND private.chat_feature_enabled_for_tenant(c.tenant_id,c.conversation_type)
        )
        OR (c.conversation_type='support' AND private.powerhub_has_platform_capability('manageSupportChat'))
      )
  );
$function$;
ALTER FUNCTION private.chat_can_access_conversation(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_can_access_conversation(bigint) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.chat_create_conversation(
  p_tenant_id bigint,p_conversation_type text DEFAULT 'assistant',
  p_subject text DEFAULT NULL,p_priority text DEFAULT 'normal'
)
RETURNS public.chat_conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE v_user_id bigint; v_row public.chat_conversations;
BEGIN
  v_user_id:=private.chat_current_user_id();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF NOT (p_tenant_id=ANY(powerhub_private.current_tenant_ids())) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF p_conversation_type NOT IN ('assistant','support') THEN RAISE EXCEPTION 'INVALID_CONVERSATION_TYPE'; END IF;
  IF p_priority NOT IN ('low','normal','high','urgent') THEN RAISE EXCEPTION 'INVALID_PRIORITY'; END IF;
  IF NOT private.chat_feature_enabled_for_tenant(p_tenant_id,p_conversation_type) THEN
    RAISE EXCEPTION 'CHAT_FEATURE_DISABLED' USING errcode='P0001';
  END IF;
  IF NOT private.chat_rate_limit_consume(v_user_id,format('conversation:%s',p_conversation_type),600,5) THEN
    RAISE EXCEPTION USING errcode='P0001',message='RATE_LIMITED';
  END IF;
  INSERT INTO public.chat_conversations(tenant_id,conversation_type,status,subject,priority,created_by_user_id,last_message_at)
  VALUES(p_tenant_id,p_conversation_type,
    CASE WHEN p_conversation_type='support' THEN 'SUPPORT_PENDING' ELSE 'AI_ACTIVE' END,
    nullif(btrim(p_subject),''),p_priority,v_user_id,now())
  RETURNING * INTO v_row;
  INSERT INTO public.chat_participants(conversation_id,tenant_id,user_id,participant_role)
  VALUES(v_row.id,v_row.tenant_id,v_user_id,'owner');
  RETURN v_row;
END;
$function$;
ALTER FUNCTION private.chat_create_conversation(bigint,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_create_conversation(bigint,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.chat_create_conversation(bigint,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION private.chat_create_inbox_notification_for_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE v_recipient bigint; v_conversation_type text;
BEGIN
  IF NEW.visibility='internal' OR NEW.sender_user_id IS NULL THEN RETURN NEW; END IF;
  SELECT c.conversation_type INTO v_conversation_type FROM public.chat_conversations c
  WHERE c.id=NEW.conversation_id AND c.tenant_id=NEW.tenant_id;
  IF v_conversation_type IS NULL THEN RETURN NEW; END IF;
  FOR v_recipient IN
    SELECT cp.user_id FROM public.chat_participants cp
    WHERE cp.conversation_id=NEW.conversation_id AND cp.tenant_id=NEW.tenant_id
      AND cp.user_id<>NEW.sender_user_id AND cp.left_at IS NULL
      AND private.chat_feature_enabled_for_tenant(NEW.tenant_id,v_conversation_type)
    UNION
    SELECT support_user.id FROM private.chat_support_user_ids() AS support_user
    WHERE v_conversation_type='support'
  LOOP
    IF v_recipient IS NOT NULL AND v_recipient<>NEW.sender_user_id THEN
      INSERT INTO public.chat_inbox_notifications(user_id,tenant_id,conversation_id,message_id,notification_type,title,body)
      VALUES(v_recipient,NEW.tenant_id,NEW.conversation_id,NEW.id,'chat_message',
        'رسالة جديدة في PowerHub',left(coalesce(NEW.body,'لديك رسالة جديدة في الدردشة.'),180))
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION private.chat_create_inbox_notification_for_message() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_create_inbox_notification_for_message() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.chat_mark_notification_read(p_notification_id bigint)
RETURNS public.chat_inbox_notifications
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE v_user_id bigint; v_row public.chat_inbox_notifications;
BEGIN
  v_user_id:=private.chat_current_user_id();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  UPDATE public.chat_inbox_notifications n SET read_at=coalesce(n.read_at,now())
  WHERE n.id=p_notification_id AND n.user_id=v_user_id
    AND (n.conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=n.conversation_id AND c.tenant_id=n.tenant_id
        AND private.chat_rls_can_select_conversation(c.id,c.tenant_id)
    ))
  RETURNING n.* INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  RETURN v_row;
END;
$function$;
ALTER FUNCTION private.chat_mark_notification_read(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_mark_notification_read(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.chat_mark_notification_read(bigint) TO authenticated;

CREATE OR REPLACE FUNCTION private.chat_unread_notification_count()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $function$
  SELECT count(*)::integer FROM public.chat_inbox_notifications n
  WHERE n.user_id=private.chat_current_user_id() AND n.read_at IS NULL
    AND (n.conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM public.chat_conversations c
      WHERE c.id=n.conversation_id AND c.tenant_id=n.tenant_id
        AND private.chat_rls_can_select_conversation(c.id,c.tenant_id)
    ));
$function$;
ALTER FUNCTION private.chat_unread_notification_count() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.chat_unread_notification_count() FROM PUBLIC,anon,authenticated;

DROP POLICY IF EXISTS chat_messages_select_conversation_access ON public.chat_messages;
CREATE POLICY chat_messages_select_conversation_access ON public.chat_messages FOR SELECT TO authenticated
USING (
  (private.powerhub_has_platform_capability('manageSupportChat') AND EXISTS (
    SELECT 1 FROM public.chat_conversations c WHERE c.id=chat_messages.conversation_id
      AND c.tenant_id=chat_messages.tenant_id AND c.conversation_type='support'))
  OR (visibility='public' AND private.chat_rls_can_select_conversation(conversation_id,tenant_id))
);

DROP POLICY IF EXISTS chat_conversation_tags_select_access ON public.chat_conversation_tags;
CREATE POLICY chat_conversation_tags_select_access ON public.chat_conversation_tags FOR SELECT TO authenticated
USING (private.chat_rls_can_select_conversation(conversation_id,tenant_id));

DROP POLICY IF EXISTS chat_handoffs_select_conversation_access ON public.chat_bot_handoffs;
CREATE POLICY chat_handoffs_select_conversation_access ON public.chat_bot_handoffs FOR SELECT TO authenticated
USING (private.chat_rls_can_select_conversation(conversation_id,tenant_id));

DROP POLICY IF EXISTS chat_attachments_select_conversation_access ON public.chat_message_attachments;
CREATE POLICY chat_attachments_select_conversation_access ON public.chat_message_attachments FOR SELECT TO authenticated
USING (private.chat_rls_can_select_conversation(conversation_id,tenant_id));

DROP POLICY IF EXISTS chat_message_receipts_select_access ON public.chat_message_receipts;
CREATE POLICY chat_message_receipts_select_access ON public.chat_message_receipts FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.chat_messages m
  WHERE m.id=chat_message_receipts.message_id
    AND private.chat_rls_can_select_conversation(m.conversation_id,m.tenant_id)
    AND (
      chat_message_receipts.user_id=powerhub_private.current_user_id()
      OR m.sender_user_id=powerhub_private.current_user_id()
      OR private.powerhub_has_platform_capability('manageSupportChat')
    )
));

DROP POLICY IF EXISTS chat_inbox_notifications_select_own ON public.chat_inbox_notifications;
CREATE POLICY chat_inbox_notifications_select_own ON public.chat_inbox_notifications FOR SELECT TO authenticated
USING (
  user_id=powerhub_private.current_user_id()
  AND (conversation_id IS NULL OR EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=chat_inbox_notifications.conversation_id
      AND c.tenant_id=chat_inbox_notifications.tenant_id
      AND private.chat_rls_can_select_conversation(c.id,c.tenant_id)
  ))
);

DROP POLICY IF EXISTS chat_support_feedback_select_own_or_support ON public.chat_support_feedback;
CREATE POLICY chat_support_feedback_select_own_or_support ON public.chat_support_feedback FOR SELECT TO authenticated
USING (
  (user_id=powerhub_private.current_user_id()
   AND private.chat_rls_can_select_conversation(conversation_id,tenant_id))
  OR (private.powerhub_has_platform_capability('manageSupportChat') AND EXISTS (
    SELECT 1 FROM public.chat_conversations c WHERE c.id=chat_support_feedback.conversation_id
      AND c.tenant_id=chat_support_feedback.tenant_id AND c.conversation_type='support'))
);

DROP POLICY IF EXISTS chat_storage_select_conversation_access ON storage.objects;
CREATE POLICY chat_storage_select_conversation_access ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id='powerhub-private'
  AND EXISTS (
    SELECT 1 FROM public.chat_message_attachments cma
    WHERE cma.tenant_id IS NOT NULL AND cma.storage_bucket=storage.objects.bucket_id
      AND cma.storage_path=storage.objects.name
      AND private.chat_rls_can_select_conversation(cma.conversation_id,cma.tenant_id)
  )
);

DROP POLICY IF EXISTS chat_conversation_receive ON realtime.messages;
CREATE POLICY chat_conversation_receive ON realtime.messages FOR SELECT TO authenticated
USING (
  private=true AND extension='broadcast' AND (
    (topic ~ '^chat:conversation:[0-9]+$' AND EXISTS (
      SELECT 1 FROM public.chat_conversations c
      JOIN public.chat_participants cp ON cp.conversation_id=c.id AND cp.tenant_id=c.tenant_id
      JOIN public.tenant_members tm ON tm.tenant_id=c.tenant_id AND tm.user_id=cp.user_id
      WHERE c.id=substring(realtime.messages.topic from 'chat:conversation:([0-9]+)$')::bigint
        AND cp.user_id=powerhub_private.current_user_id() AND cp.left_at IS NULL
        AND tm.user_id=powerhub_private.current_user_id()
        AND tm.is_active=true AND tm.membership_status='active'
        AND (tm.expires_at IS NULL OR tm.expires_at>now())
        AND private.chat_rls_can_select_conversation(c.id,c.tenant_id)
    ))
    OR (topic='chat:support:queue' AND private.powerhub_has_platform_capability('manageSupportChat'))
  )
);

DROP POLICY IF EXISTS chat_conversation_send ON realtime.messages;
CREATE POLICY chat_conversation_send ON realtime.messages FOR INSERT TO authenticated
WITH CHECK (
  private=true AND extension='broadcast' AND (
    (topic ~ '^chat:conversation:[0-9]+$' AND EXISTS (
      SELECT 1 FROM public.chat_conversations c
      JOIN public.chat_participants cp ON cp.conversation_id=c.id AND cp.tenant_id=c.tenant_id
      JOIN public.tenant_members tm ON tm.tenant_id=c.tenant_id AND tm.user_id=cp.user_id
      WHERE c.id=substring(realtime.messages.topic from 'chat:conversation:([0-9]+)$')::bigint
        AND cp.user_id=powerhub_private.current_user_id() AND cp.left_at IS NULL
        AND tm.user_id=powerhub_private.current_user_id()
        AND tm.is_active=true AND tm.membership_status='active'
        AND (tm.expires_at IS NULL OR tm.expires_at>now())
        AND private.chat_rls_can_select_conversation(c.id,c.tenant_id)
    ))
    OR (topic='chat:support:queue' AND private.powerhub_has_platform_capability('manageSupportChat'))
  )
);

DROP POLICY IF EXISTS chat_support_receive_conversation ON realtime.messages;
CREATE POLICY chat_support_receive_conversation ON realtime.messages FOR SELECT TO authenticated
USING (
  private=true AND extension='broadcast' AND topic ~ '^chat:conversation:[0-9]+$'
  AND private.powerhub_has_platform_capability('manageSupportChat')
  AND EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=substring(realtime.messages.topic from 'chat:conversation:([0-9]+)$')::bigint
      AND c.conversation_type='support'
  )
);

DROP POLICY IF EXISTS chat_support_send_conversation ON realtime.messages;
CREATE POLICY chat_support_send_conversation ON realtime.messages FOR INSERT TO authenticated
WITH CHECK (
  private=true AND extension='broadcast' AND topic ~ '^chat:conversation:[0-9]+$'
  AND private.powerhub_has_platform_capability('manageSupportChat')
  AND EXISTS (
    SELECT 1 FROM public.chat_conversations c
    WHERE c.id=substring(realtime.messages.topic from 'chat:conversation:([0-9]+)$')::bigint
      AND c.conversation_type='support'
  )
);

SELECT pg_notify('pgrst','reload schema');
