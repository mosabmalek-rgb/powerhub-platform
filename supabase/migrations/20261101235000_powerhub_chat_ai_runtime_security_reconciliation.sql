-- Harden PowerHub AI's service-only runtime and gate user notification broadcasts by live chat access.
-- Forward-only reconciliation: no existing chat, notification, or AI rows are deleted or rewritten.

DO $preflight$
BEGIN
  IF to_regclass('private.chat_ai_settings') IS NULL
     OR to_regclass('private.chat_ai_request_claims') IS NULL
     OR to_regclass('public.chat_conversations') IS NULL
     OR to_regclass('public.chat_messages') IS NULL
     OR to_regclass('public.chat_inbox_notifications') IS NULL
     OR to_regprocedure('private.chat_feature_enabled_for_tenant(bigint,text)') IS NULL
     OR to_regprocedure('private.chat_rls_can_select_conversation(bigint,bigint)') IS NULL
     OR to_regprocedure('powerhub_private.current_user_id()') IS NULL
     OR to_regclass('realtime.messages') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_CHAT_AI_RUNTIME_PREREQUISITES_MISSING';
  END IF;
END
$preflight$;

-- The application server calls this RPC through its service-role client.
-- Browser roles must not be able to read global AI settings directly.
CREATE OR REPLACE FUNCTION public.chat_ai_get_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=''
AS $function$
DECLARE
  v_settings jsonb;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role',true),'') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  SELECT to_jsonb(s) INTO v_settings
  FROM private.chat_ai_settings s
  WHERE s.id=true;

  RETURN coalesce(v_settings,'{}'::jsonb);
END;
$function$;
ALTER FUNCTION public.chat_ai_get_settings() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_ai_get_settings() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.chat_ai_get_settings() TO service_role;

-- A claim is granted only to the winner of an INSERT/expired-lease UPDATE.
-- The previous "claimed_at within one second" test allowed concurrent duplicate
-- requests to both observe success. Serialize per message and validate the exact
-- tenant, conversation, active member, public human message, and feature entitlement.
CREATE OR REPLACE FUNCTION public.chat_ai_claim_request(
  p_request_id text,
  p_conversation_id bigint,
  p_message_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_lease_seconds integer DEFAULT 45
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
VOLATILE
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_claimed boolean := false;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role',true),'') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  IF p_request_id IS NULL
     OR p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_conversation_id IS NULL OR p_conversation_id<=0
     OR p_message_id IS NULL OR p_message_id<=0
     OR p_tenant_id IS NULL OR p_tenant_id<=0
     OR p_user_id IS NULL OR p_user_id<=0
     OR p_lease_seconds IS NULL
     OR p_lease_seconds<10 OR p_lease_seconds>180 THEN
    RAISE EXCEPTION 'INVALID_CLAIM';
  END IF;

  -- Prevent separate request IDs from concurrently claiming the same message.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text || ':' || p_message_id::text,0)
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.chat_conversations c
    JOIN public.chat_messages m
      ON m.id=p_message_id
     AND m.conversation_id=c.id
     AND m.tenant_id=c.tenant_id
    JOIN public.tenant_members tm
      ON tm.tenant_id=c.tenant_id
     AND tm.user_id=p_user_id
    WHERE c.id=p_conversation_id
      AND c.tenant_id=p_tenant_id
      AND c.conversation_type='assistant'
      AND m.sender_user_id=p_user_id
      AND m.sender_type='human'
      AND m.visibility='public'
      AND tm.is_active=true
      AND tm.membership_status='active'
      AND (tm.expires_at IS NULL OR tm.expires_at>v_now)
  ) THEN
    RAISE EXCEPTION 'CLAIM_SCOPE_MISMATCH';
  END IF;

  IF NOT private.chat_feature_enabled_for_tenant(p_tenant_id,'assistant') THEN
    RAISE EXCEPTION 'CHAT_FEATURE_DISABLED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.chat_ai_request_claims c
    WHERE c.request_id=p_request_id
      AND (
        c.conversation_id<>p_conversation_id
        OR c.message_id<>p_message_id
        OR c.tenant_id<>p_tenant_id
        OR c.user_id<>p_user_id
      )
  ) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.chat_ai_request_claims c
    WHERE c.conversation_id=p_conversation_id
      AND c.message_id=p_message_id
      AND c.request_id<>p_request_id
      AND c.expires_at>v_now
  ) THEN
    RAISE EXCEPTION 'MESSAGE_ALREADY_CLAIMED';
  END IF;

  WITH claim AS (
    INSERT INTO private.chat_ai_request_claims(
      request_id,conversation_id,message_id,tenant_id,user_id,claimed_at,expires_at
    )
    VALUES (
      p_request_id,p_conversation_id,p_message_id,p_tenant_id,p_user_id,
      v_now,v_now+make_interval(secs=>p_lease_seconds)
    )
    ON CONFLICT(request_id) DO UPDATE
      SET conversation_id=EXCLUDED.conversation_id,
          message_id=EXCLUDED.message_id,
          tenant_id=EXCLUDED.tenant_id,
          user_id=EXCLUDED.user_id,
          claimed_at=EXCLUDED.claimed_at,
          expires_at=EXCLUDED.expires_at
      WHERE private.chat_ai_request_claims.expires_at<=v_now
    RETURNING request_id
  )
  SELECT EXISTS(SELECT 1 FROM claim) INTO v_claimed;

  RETURN v_claimed;
END;
$function$;
ALTER FUNCTION public.chat_ai_claim_request(text,bigint,bigint,bigint,bigint,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_ai_claim_request(text,bigint,bigint,bigint,bigint,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.chat_ai_claim_request(text,bigint,bigint,bigint,bigint,integer)
  TO service_role;

-- Broadcast payloads carry the notification row in payload.record. Verify that
-- the notification still belongs to the receiving user and that its conversation
-- remains visible under the same tenant membership + feature gate as REST reads.
DROP POLICY IF EXISTS chat_user_notification_receive ON realtime.messages;
CREATE POLICY chat_user_notification_receive ON realtime.messages
FOR SELECT TO authenticated
USING (
  private=true
  AND extension='broadcast'
  AND topic ~ '^chat:user:[0-9]+$'
  AND split_part(topic,':',3)=powerhub_private.current_user_id()::text
  AND EXISTS (
    SELECT 1
    FROM public.chat_inbox_notifications n
    WHERE n.id::text=payload #>> '{record,id}'
      AND n.user_id=powerhub_private.current_user_id()
      AND (
        n.conversation_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.chat_conversations c
          WHERE c.id=n.conversation_id
            AND c.tenant_id=n.tenant_id
            AND private.chat_rls_can_select_conversation(c.id,c.tenant_id)
        )
      )
  )
);

SELECT pg_notify('pgrst','reload schema');
