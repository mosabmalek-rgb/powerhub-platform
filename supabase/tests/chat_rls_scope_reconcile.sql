\set ON_ERROR_STOP on

DO $roles$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $roles$;
DO $roles$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $roles$;
DO $roles$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $roles$;

CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE SCHEMA powerhub_private;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $function$
  SELECT nullif(current_setting('test.auth_uid',true),'')::uuid
$function$;

CREATE TABLE public.users (
  id bigint PRIMARY KEY, auth_user_id uuid NOT NULL UNIQUE,
  platform_role text, account_status text NOT NULL DEFAULT 'active'
);
CREATE TABLE public.tenant_members (
  id bigint PRIMARY KEY, tenant_id bigint NOT NULL, user_id bigint NOT NULL,
  is_active boolean NOT NULL, membership_status text NOT NULL, expires_at timestamptz
);
CREATE TABLE private.platform_capability_policies (
  platform_role text NOT NULL, capability text NOT NULL, is_allowed boolean NOT NULL,
  PRIMARY KEY(platform_role,capability)
);

CREATE OR REPLACE FUNCTION powerhub_private.current_user_id()
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $function$
  SELECT u.id FROM public.users u WHERE u.auth_user_id=auth.uid() LIMIT 1
$function$;
CREATE OR REPLACE FUNCTION powerhub_private.current_tenant_ids()
RETURNS bigint[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $function$
  SELECT coalesce(array_agg(tm.tenant_id),'{}'::bigint[])
  FROM public.tenant_members tm JOIN public.users u ON u.id=tm.user_id
  WHERE u.auth_user_id=auth.uid() AND tm.is_active=true
    AND tm.membership_status='active' AND (tm.expires_at IS NULL OR tm.expires_at>now())
$function$;
CREATE OR REPLACE FUNCTION private.powerhub_has_platform_capability(p_capability text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    JOIN private.platform_capability_policies p
      ON p.platform_role=u.platform_role AND p.capability=p_capability AND p.is_allowed=true
    WHERE u.auth_user_id=auth.uid() AND u.account_status='active'
  )
$function$;

REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
REVOKE ALL ON FUNCTION powerhub_private.current_user_id() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION powerhub_private.current_tenant_ids() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION private.powerhub_has_platform_capability(text) FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA auth,private,powerhub_private TO authenticated;
GRANT EXECUTE ON FUNCTION powerhub_private.current_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION powerhub_private.current_tenant_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION private.powerhub_has_platform_capability(text) TO authenticated;

CREATE TABLE public.chat_conversations(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,conversation_type text NOT NULL);
CREATE TABLE public.chat_participants(conversation_id bigint NOT NULL,tenant_id bigint NOT NULL,user_id bigint NOT NULL,left_at timestamptz);
CREATE TABLE public.chat_bot_handoffs(id bigint PRIMARY KEY,conversation_id bigint NOT NULL,tenant_id bigint NOT NULL);
CREATE TABLE public.chat_message_attachments(id bigint PRIMARY KEY,conversation_id bigint NOT NULL,tenant_id bigint NOT NULL);
CREATE TABLE public.chat_messages(id bigint PRIMARY KEY,conversation_id bigint NOT NULL,tenant_id bigint NOT NULL,sender_user_id bigint NOT NULL,visibility text NOT NULL DEFAULT 'public');
CREATE TABLE public.chat_message_receipts(id bigint PRIMARY KEY,message_id bigint NOT NULL,conversation_id bigint NOT NULL,tenant_id bigint NOT NULL,user_id bigint NOT NULL);
CREATE TABLE public.chat_conversation_tags(id bigint PRIMARY KEY,conversation_id bigint NOT NULL,tenant_id bigint NOT NULL);
CREATE TABLE public.chat_support_assignments(id bigint PRIMARY KEY,conversation_id bigint NOT NULL,tenant_id bigint NOT NULL);
CREATE TABLE public.chat_ticket_events(id bigint PRIMARY KEY,conversation_id bigint NOT NULL,tenant_id bigint NOT NULL);
CREATE TABLE public.chat_support_feedback(id bigint PRIMARY KEY,conversation_id bigint NOT NULL,tenant_id bigint NOT NULL,user_id bigint NOT NULL);

ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_bot_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_message_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_conversation_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_support_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_support_feedback ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.chat_conversations,public.chat_participants,public.chat_bot_handoffs,
  public.chat_message_attachments,public.chat_message_receipts,public.chat_messages,
  public.chat_conversation_tags,public.chat_support_assignments,public.chat_ticket_events,
  public.chat_support_feedback TO authenticated;
GRANT INSERT ON public.chat_support_feedback TO authenticated;
GRANT ALL ON public.chat_conversations,public.chat_participants,public.chat_bot_handoffs,
  public.chat_message_attachments,public.chat_message_receipts,public.chat_messages,
  public.chat_conversation_tags,public.chat_support_assignments,public.chat_ticket_events,
  public.chat_support_feedback TO service_role;

-- Broad Staging-style predicates: each is replaced by the forward migrations below.
CREATE POLICY chat_conversations_select_participant ON public.chat_conversations
FOR SELECT TO authenticated USING (
  EXISTS(SELECT 1 FROM public.chat_participants cp JOIN public.tenant_members tm
    ON tm.tenant_id=chat_conversations.tenant_id AND tm.user_id=cp.user_id
    WHERE cp.conversation_id=chat_conversations.id AND cp.tenant_id=chat_conversations.tenant_id
      AND cp.user_id=powerhub_private.current_user_id() AND cp.left_at IS NULL
      AND tm.is_active AND tm.membership_status='active')
  OR private.powerhub_has_platform_capability('manageSupportChat')
);
CREATE POLICY chat_participants_select_self_or_support ON public.chat_participants
FOR SELECT TO authenticated USING (
  (user_id=powerhub_private.current_user_id() AND left_at IS NULL
    AND EXISTS(SELECT 1 FROM public.tenant_members tm WHERE tm.tenant_id=chat_participants.tenant_id
      AND tm.user_id=powerhub_private.current_user_id() AND tm.is_active AND tm.membership_status='active'))
  OR private.powerhub_has_platform_capability('manageSupportChat')
);
CREATE POLICY chat_handoffs_select_conversation_access ON public.chat_bot_handoffs
FOR SELECT TO authenticated USING (
  EXISTS(SELECT 1 FROM public.chat_participants cp JOIN public.tenant_members tm
    ON tm.tenant_id=chat_bot_handoffs.tenant_id AND tm.user_id=cp.user_id
    WHERE cp.conversation_id=chat_bot_handoffs.conversation_id AND cp.tenant_id=chat_bot_handoffs.tenant_id
      AND cp.user_id=powerhub_private.current_user_id() AND cp.left_at IS NULL
      AND tm.is_active AND tm.membership_status='active')
  OR private.powerhub_has_platform_capability('manageSupportChat')
);
CREATE POLICY chat_attachments_select_conversation_access ON public.chat_message_attachments
FOR SELECT TO authenticated USING (
  EXISTS(SELECT 1 FROM public.chat_participants cp JOIN public.tenant_members tm
    ON tm.tenant_id=chat_message_attachments.tenant_id AND tm.user_id=cp.user_id
    WHERE cp.conversation_id=chat_message_attachments.conversation_id AND cp.tenant_id=chat_message_attachments.tenant_id
      AND cp.user_id=powerhub_private.current_user_id() AND cp.left_at IS NULL
      AND tm.is_active AND tm.membership_status='active')
  OR private.powerhub_has_platform_capability('manageSupportChat')
);
CREATE POLICY chat_message_receipts_select_access ON public.chat_message_receipts
FOR SELECT TO authenticated USING (
  user_id=powerhub_private.current_user_id()
  OR EXISTS(SELECT 1 FROM public.chat_messages m WHERE m.id=chat_message_receipts.message_id
    AND m.sender_user_id=powerhub_private.current_user_id())
  OR private.powerhub_has_platform_capability('manageSupportChat')
);
CREATE POLICY chat_messages_select_conversation_access ON public.chat_messages
FOR SELECT TO authenticated USING (
  private.powerhub_has_platform_capability('manageSupportChat')
  OR (visibility='public' AND EXISTS(SELECT 1 FROM public.chat_participants cp
    WHERE cp.conversation_id=chat_messages.conversation_id AND cp.tenant_id=chat_messages.tenant_id
      AND cp.user_id=powerhub_private.current_user_id() AND cp.left_at IS NULL))
);
CREATE POLICY chat_conversation_tags_select_access ON public.chat_conversation_tags
FOR SELECT TO authenticated USING (
  private.powerhub_has_platform_capability('manageSupportChat')
  OR EXISTS(SELECT 1 FROM public.chat_participants cp
    WHERE cp.conversation_id=chat_conversation_tags.conversation_id
      AND cp.user_id=powerhub_private.current_user_id() AND cp.left_at IS NULL)
);
CREATE POLICY chat_assignments_select_support_only ON public.chat_support_assignments
FOR SELECT TO authenticated USING (private.powerhub_has_platform_capability('manageSupportChat'));
CREATE POLICY chat_ticket_events_select_support ON public.chat_ticket_events
FOR SELECT TO authenticated USING (private.powerhub_has_platform_capability('manageSupportChat'));
CREATE POLICY chat_support_feedback_select_own_or_support ON public.chat_support_feedback
FOR SELECT TO authenticated USING (
  user_id=powerhub_private.current_user_id()
  OR private.powerhub_has_platform_capability('manageSupportChat')
);

\ir ../migrations/20261030240000_powerhub_chat_rls_scope_reconcile.sql
\ir ../migrations/20261030240000_powerhub_chat_rls_scope_reconcile.sql
\ir ../migrations/20261030250000_powerhub_chat_support_conversation_scope_hardening.sql
\ir ../migrations/20261030250000_powerhub_chat_support_conversation_scope_hardening.sql

INSERT INTO public.users(id,auth_user_id,platform_role,account_status) VALUES
  (1,'11111111-1111-4111-8111-111111111111',NULL,'active'),
  (2,'22222222-2222-4222-8222-222222222222',NULL,'active'),
  (3,'33333333-3333-4333-8333-333333333333','platform_support','active'),
  (4,'44444444-4444-4444-8444-444444444444',NULL,'active'),
  (5,'55555555-5555-4555-8555-555555555555',NULL,'active');
INSERT INTO public.tenant_members(id,tenant_id,user_id,is_active,membership_status,expires_at) VALUES
  (1,10,1,true,'active',NULL),(2,10,2,true,'active',NULL),
  (4,20,4,true,'active',NULL),(5,10,5,true,'active',NULL);
INSERT INTO private.platform_capability_policies(platform_role,capability,is_allowed)
VALUES ('platform_support','manageSupportChat',true);

INSERT INTO public.chat_conversations(id,tenant_id,conversation_type) VALUES
  (100,10,'assistant'),(101,10,'support'),(200,20,'assistant');
INSERT INTO public.chat_participants(conversation_id,tenant_id,user_id,left_at) VALUES
  (100,10,1,NULL),(100,10,2,NULL),(101,10,2,NULL),(200,20,4,NULL);
INSERT INTO public.chat_bot_handoffs(id,conversation_id,tenant_id) VALUES
  (1000,100,10),(1001,101,10),(2000,200,20);
INSERT INTO public.chat_message_attachments(id,conversation_id,tenant_id) VALUES
  (1000,100,10),(1001,101,10),(2000,200,20);

INSERT INTO public.chat_messages(id,conversation_id,tenant_id,sender_user_id,visibility) VALUES
  (500,100,10,2,'public'),(501,101,10,2,'public'),(502,200,20,4,'public'),
  (503,100,10,2,'internal'),(504,101,10,2,'internal');
INSERT INTO public.chat_message_receipts(id,message_id,conversation_id,tenant_id,user_id) VALUES
  (600,500,100,10,1),(601,501,101,10,2),(602,502,200,20,4);
INSERT INTO public.chat_conversation_tags(id,conversation_id,tenant_id) VALUES
  (800,100,10),(801,101,10),(802,200,20);
INSERT INTO public.chat_support_assignments(id,conversation_id,tenant_id) VALUES
  (900,100,10),(901,101,10),(902,200,20);
INSERT INTO public.chat_ticket_events(id,conversation_id,tenant_id) VALUES
  (950,100,10),(951,101,10),(952,200,20);
INSERT INTO public.chat_support_feedback(id,conversation_id,tenant_id,user_id) VALUES
  (700,101,10,1),(701,100,10,1),(702,101,10,2);

DO $assert_policy_count$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM pg_policy
  WHERE polrelid IN (
    'public.chat_conversations'::regclass,'public.chat_participants'::regclass,
    'public.chat_bot_handoffs'::regclass,'public.chat_message_attachments'::regclass,
    'public.chat_message_receipts'::regclass,'public.chat_messages'::regclass,
    'public.chat_conversation_tags'::regclass,'public.chat_support_assignments'::regclass,
    'public.chat_ticket_events'::regclass,'public.chat_support_feedback'::regclass
  );
  IF v_count<>10 THEN RAISE EXCEPTION 'CHAT_CANONICAL_POLICY_COUNT_MISMATCH: %',v_count; END IF;
  IF has_function_privilege('anon','private.chat_rls_can_select_conversation(bigint,bigint)','EXECUTE')
     OR has_function_privilege('anon','private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.chat_rls_can_select_conversation(bigint,bigint)','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_HELPER_EXECUTE_GRANTS_MISMATCH';
  END IF;
  IF has_table_privilege('anon','public.chat_messages','SELECT')
     OR has_table_privilege('authenticated','public.chat_messages','INSERT')
     OR has_table_privilege('authenticated','public.chat_messages','UPDATE')
     OR has_table_privilege('authenticated','public.chat_messages','DELETE')
     OR NOT has_table_privilege('service_role','public.chat_messages','INSERT')
     OR NOT has_table_privilege('authenticated','public.chat_support_feedback','INSERT') THEN
    RAISE EXCEPTION 'CHAT_TABLE_ACL_CHANGED_UNEXPECTEDLY';
  END IF;
END
$assert_policy_count$;

SET ROLE authenticated;
SET test.auth_uid='11111111-1111-4111-8111-111111111111';
DO $tenant_user$
BEGIN
  IF (SELECT count(*) FROM public.chat_conversations)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_conversations WHERE id=100) THEN
    RAISE EXCEPTION 'CHAT_TENANT_CONVERSATION_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_messages)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_messages WHERE id=500)
     OR EXISTS(SELECT 1 FROM public.chat_messages WHERE id=503 OR id=501 OR id=502 OR id=504) THEN
    RAISE EXCEPTION 'CHAT_TENANT_MESSAGE_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_bot_handoffs)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_bot_handoffs WHERE id=1000)
     OR (SELECT count(*) FROM public.chat_message_attachments)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_message_attachments WHERE id=1000) THEN
    RAISE EXCEPTION 'CHAT_TENANT_CHILD_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_participants)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_participants WHERE user_id=1)
     OR EXISTS(SELECT 1 FROM public.chat_participants WHERE user_id<>1) THEN
    RAISE EXCEPTION 'CHAT_PARTICIPANT_SELF_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_message_receipts)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE id=600) THEN
    RAISE EXCEPTION 'CHAT_RECEIPT_SELF_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_conversation_tags)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_conversation_tags WHERE id=800)
     OR (SELECT count(*) FROM public.chat_support_feedback)<>2 THEN
    RAISE EXCEPTION 'CHAT_TENANT_TAG_OR_FEEDBACK_SCOPE_BROKEN';
  END IF;
END
$tenant_user$;

SET test.auth_uid='55555555-5555-4555-8555-555555555555';
DO $non_participant$
BEGIN
  IF (SELECT count(*) FROM public.chat_conversations)<>0
     OR (SELECT count(*) FROM public.chat_bot_handoffs)<>0
     OR (SELECT count(*) FROM public.chat_message_attachments)<>0
     OR (SELECT count(*) FROM public.chat_messages)<>0
     OR (SELECT count(*) FROM public.chat_conversation_tags)<>0 THEN
    RAISE EXCEPTION 'CHAT_NON_PARTICIPANT_ACCESS_GRANTED';
  END IF;
END
$non_participant$;

SET test.auth_uid='33333333-3333-4333-8333-333333333333';
DO $support_operator$
BEGIN
  IF (SELECT count(*) FROM public.chat_conversations)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_conversations WHERE id=101 AND conversation_type='support')
     OR EXISTS(SELECT 1 FROM public.chat_conversations WHERE conversation_type<>'support') THEN
    RAISE EXCEPTION 'CHAT_SUPPORT_CONVERSATION_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_messages)<>2
     OR EXISTS(SELECT 1 FROM public.chat_messages WHERE conversation_id<>101) THEN
    RAISE EXCEPTION 'CHAT_SUPPORT_MESSAGE_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_bot_handoffs)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_bot_handoffs WHERE id=1001)
     OR (SELECT count(*) FROM public.chat_message_attachments)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_message_attachments WHERE id=1001) THEN
    RAISE EXCEPTION 'CHAT_SUPPORT_CHILD_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_participants)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_participants WHERE conversation_id=101) THEN
    RAISE EXCEPTION 'CHAT_SUPPORT_PARTICIPANT_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_message_receipts)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_message_receipts WHERE id=601) THEN
    RAISE EXCEPTION 'CHAT_SUPPORT_RECEIPT_SCOPE_BROKEN';
  END IF;
  IF (SELECT count(*) FROM public.chat_conversation_tags)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_conversation_tags WHERE id=801)
     OR (SELECT count(*) FROM public.chat_support_assignments)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_support_assignments WHERE id=901)
     OR (SELECT count(*) FROM public.chat_ticket_events)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_ticket_events WHERE id=951)
     OR (SELECT count(*) FROM public.chat_support_feedback)<>2
     OR EXISTS(SELECT 1 FROM public.chat_support_feedback WHERE conversation_id<>101) THEN
    RAISE EXCEPTION 'CHAT_SUPPORT_TICKET_METADATA_SCOPE_BROKEN';
  END IF;
END
$support_operator$;

SET test.auth_uid='44444444-4444-4444-8444-444444444444';
DO $second_tenant$
BEGIN
  IF (SELECT count(*) FROM public.chat_conversations)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_conversations WHERE id=200)
     OR (SELECT count(*) FROM public.chat_messages)<>1
     OR NOT EXISTS(SELECT 1 FROM public.chat_messages WHERE id=502)
     OR EXISTS(SELECT 1 FROM public.chat_conversations WHERE tenant_id<>20) THEN
    RAISE EXCEPTION 'CHAT_CROSS_TENANT_ISOLATION_BROKEN';
  END IF;
END
$second_tenant$;
RESET ROLE;

UPDATE public.tenant_members
SET is_active=false,membership_status='suspended'
WHERE tenant_id=10 AND user_id=1;

SET ROLE authenticated;
SET test.auth_uid='11111111-1111-4111-8111-111111111111';
DO $revoked_membership$
BEGIN
  IF (SELECT count(*) FROM public.chat_conversations)<>0
     OR (SELECT count(*) FROM public.chat_participants)<>0
     OR (SELECT count(*) FROM public.chat_bot_handoffs)<>0
     OR (SELECT count(*) FROM public.chat_message_attachments)<>0
     OR (SELECT count(*) FROM public.chat_messages)<>0
     OR (SELECT count(*) FROM public.chat_conversation_tags)<>0 THEN
    RAISE EXCEPTION 'CHAT_REVOKED_MEMBERSHIP_ACCESS_REMAINS';
  END IF;
END
$revoked_membership$;
RESET ROLE;

SELECT 'Chat RLS migrations passed: participant scope, support-conversation-only reads, ticket metadata, receipts, tenant isolation, revoked membership, and repeatability' AS result;
