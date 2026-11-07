\set ON_ERROR_STOP on

DO $roles$
BEGIN
  BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE SCHEMA auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid;
$function$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated,service_role;

CREATE TABLE public.users (
  id bigint PRIMARY KEY,
  auth_user_id uuid UNIQUE,
  account_status text NOT NULL
);
INSERT INTO public.users(id,auth_user_id,account_status) VALUES
 (10,'10000000-0000-4000-8000-000000000010','active'),
 (20,'20000000-0000-4000-8000-000000000020','active'),
 (30,'30000000-0000-4000-8000-000000000030','suspended');

CREATE TABLE public.powerhub_user_notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id),
  tenant_id bigint,
  notification_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  target_path text NOT NULL DEFAULT '/workspace',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.powerhub_user_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.powerhub_user_notifications FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.powerhub_user_notifications TO service_role;

INSERT INTO public.powerhub_user_notifications(id,user_id,tenant_id,notification_type,title)
OVERRIDING SYSTEM VALUE
VALUES
 (1001,10,1,'system_alert','User A first'),
 (1002,10,1,'system_alert','User A second'),
 (2001,20,2,'system_alert','User B first'),
 (3001,30,3,'system_alert','Suspended account');

CREATE OR REPLACE FUNCTION public.powerhub_notification_list(p_limit integer DEFAULT 20)
RETURNS TABLE (
  id bigint, notification_type text, title text, body text, target_path text,
  metadata jsonb, read_at timestamptz, created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_user_id bigint; v_limit integer;
BEGIN
  SELECT u.id INTO v_user_id FROM public.users u
  WHERE u.auth_user_id=auth.uid() AND u.account_status='active';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE='42501'; END IF;
  v_limit:=greatest(1,least(coalesce(p_limit,20),100));
  RETURN QUERY
    SELECT n.id,n.notification_type,n.title,n.body,n.target_path,n.metadata,n.read_at,n.created_at
    FROM public.powerhub_user_notifications n
    WHERE n.user_id=v_user_id
    ORDER BY n.created_at DESC,n.id DESC
    LIMIT v_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_notification_unread_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_user_id bigint; v_count integer;
BEGIN
  SELECT u.id INTO v_user_id FROM public.users u
  WHERE u.auth_user_id=auth.uid() AND u.account_status='active';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE='42501'; END IF;
  SELECT count(*)::integer INTO v_count FROM public.powerhub_user_notifications n
  WHERE n.user_id=v_user_id AND n.read_at IS NULL;
  RETURN coalesce(v_count,0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_notification_mark_read(p_notification_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_user_id bigint;
BEGIN
  SELECT u.id INTO v_user_id FROM public.users u
  WHERE u.auth_user_id=auth.uid() AND u.account_status='active';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE='42501'; END IF;
  UPDATE public.powerhub_user_notifications n
  SET read_at=coalesce(n.read_at,now())
  WHERE n.id=p_notification_id AND n.user_id=v_user_id;
  RETURN found;
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_notification_mark_all_read()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_user_id bigint; v_count integer;
BEGIN
  SELECT u.id INTO v_user_id FROM public.users u
  WHERE u.auth_user_id=auth.uid() AND u.account_status='active';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE='42501'; END IF;
  UPDATE public.powerhub_user_notifications n
  SET read_at=now()
  WHERE n.user_id=v_user_id AND n.read_at IS NULL;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_notification_list(integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.powerhub_notification_unread_count() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.powerhub_notification_mark_read(bigint) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.powerhub_notification_mark_all_read() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.powerhub_notification_list(integer),
  public.powerhub_notification_unread_count(),
  public.powerhub_notification_mark_read(bigint),
  public.powerhub_notification_mark_all_read()
TO authenticated;

DO $assert_direct_acl$
BEGIN
  IF has_table_privilege('anon','public.powerhub_user_notifications','SELECT')
     OR has_table_privilege('authenticated','public.powerhub_user_notifications','SELECT')
     OR has_table_privilege('authenticated','public.powerhub_user_notifications','UPDATE') THEN
    RAISE EXCEPTION 'NOTIFICATION_TABLE_DIRECT_BROWSER_ACCESS_PRESENT';
  END IF;
  IF NOT has_table_privilege('service_role','public.powerhub_user_notifications','SELECT')
     OR NOT has_table_privilege('service_role','public.powerhub_user_notifications','INSERT')
     OR NOT has_table_privilege('service_role','public.powerhub_user_notifications','UPDATE') THEN
    RAISE EXCEPTION 'NOTIFICATION_SERVICE_ROLE_ACCESS_MISSING';
  END IF;
  IF has_function_privilege('anon','public.powerhub_notification_list(integer)','EXECUTE')
     OR has_function_privilege('anon','public.powerhub_notification_unread_count()','EXECUTE')
     OR has_function_privilege('anon','public.powerhub_notification_mark_read(bigint)','EXECUTE')
     OR has_function_privilege('anon','public.powerhub_notification_mark_all_read()','EXECUTE') THEN
    RAISE EXCEPTION 'ANON_NOTIFICATION_RPC_EXECUTE_PRESENT';
  END IF;
  IF NOT has_function_privilege('authenticated','public.powerhub_notification_list(integer)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.powerhub_notification_unread_count()','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.powerhub_notification_mark_read(bigint)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.powerhub_notification_mark_all_read()','EXECUTE') THEN
    RAISE EXCEPTION 'AUTHENTICATED_NOTIFICATION_RPC_GRANT_MISSING';
  END IF;
END
$assert_direct_acl$;

-- No JWT identity must never fall back to a caller-supplied user identifier.
-- Exercise every browser-callable RPC, including mutations, with a missing JWT.
SELECT set_config('request.jwt.claim.sub','',false);
SET ROLE authenticated;
DO $missing_jwt$
DECLARE
  v record;
  v_denied boolean;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('list','SELECT public.powerhub_notification_list(100)'),
      ('unread_count','SELECT public.powerhub_notification_unread_count()'),
      ('mark_read','SELECT public.powerhub_notification_mark_read(1001)'),
      ('mark_all_read','SELECT public.powerhub_notification_mark_all_read()')
    ) AS calls(name,sql)
  LOOP
    v_denied:=false;
    BEGIN
      EXECUTE v.sql;
    EXCEPTION WHEN SQLSTATE '42501' THEN
      IF SQLERRM='UNAUTHORIZED' THEN v_denied:=true; ELSE RAISE; END IF;
    END;
    IF NOT v_denied THEN
      RAISE EXCEPTION 'MISSING_JWT_NOTIFICATION_RPC_ALLOWED: %',v.name;
    END IF;
  END LOOP;
END
$missing_jwt$;
RESET ROLE;
DO $missing_jwt_no_side_effects$
BEGIN
  IF (SELECT count(*) FROM public.powerhub_user_notifications WHERE read_at IS NOT NULL)<>0 THEN
    RAISE EXCEPTION 'MISSING_JWT_NOTIFICATION_MUTATION_LEFT_SIDE_EFFECT';
  END IF;
END
$missing_jwt_no_side_effects$;

-- User B cannot list or mark any of User A's notifications.
SELECT set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000020',false);
SET ROLE authenticated;
DO $user_b$
DECLARE v_marked boolean;
BEGIN
  IF (SELECT count(*) FROM public.powerhub_notification_list(100))<>1
     OR EXISTS(SELECT 1 FROM public.powerhub_notification_list(100) WHERE id<>2001) THEN
    RAISE EXCEPTION 'USER_B_NOTIFICATION_LIST_CROSSED_USER_SCOPE';
  END IF;
  IF public.powerhub_notification_unread_count()<>1 THEN
    RAISE EXCEPTION 'USER_B_UNREAD_COUNT_CROSSED_USER_SCOPE';
  END IF;
  v_marked:=public.powerhub_notification_mark_read(1001);
  IF v_marked THEN RAISE EXCEPTION 'USER_B_MARKED_USER_A_NOTIFICATION'; END IF;
  v_marked:=public.powerhub_notification_mark_read(2001);
  IF NOT v_marked THEN RAISE EXCEPTION 'USER_B_CANNOT_MARK_OWN_NOTIFICATION'; END IF;
END
$user_b$;
RESET ROLE;

-- User A sees exactly two records. User B's action must not alter A's unread state.
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000010',false);
SET ROLE authenticated;
DO $user_a$
DECLARE v_marked boolean; v_count integer;
BEGIN
  IF (SELECT count(*) FROM public.powerhub_notification_list(100))<>2
     OR EXISTS(SELECT 1 FROM public.powerhub_notification_list(100) WHERE id NOT IN (1001,1002)) THEN
    RAISE EXCEPTION 'USER_A_NOTIFICATION_LIST_CROSSED_USER_SCOPE';
  END IF;
  IF public.powerhub_notification_unread_count()<>2 THEN
    RAISE EXCEPTION 'USER_A_UNREAD_COUNT_CHANGED_BY_USER_B';
  END IF;
  v_marked:=public.powerhub_notification_mark_read(1001);
  IF NOT v_marked THEN RAISE EXCEPTION 'USER_A_CANNOT_MARK_OWN_NOTIFICATION'; END IF;
  v_count:=public.powerhub_notification_mark_all_read();
  IF v_count<>1 THEN RAISE EXCEPTION 'USER_A_MARK_ALL_READ_NOT_USER_SCOPED: %',v_count; END IF;
END
$user_a$;
RESET ROLE;

-- Disabled identities are rejected even when a notification row still exists.
SELECT set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000030',false);
SET ROLE authenticated;
DO $disabled_user$
BEGIN
  BEGIN
    PERFORM public.powerhub_notification_list(100);
    RAISE EXCEPTION 'DISABLED_USER_NOTIFICATION_ACCESS_ALLOWED';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF SQLERRM<>'UNAUTHORIZED' THEN RAISE; END IF;
  END;
END
$disabled_user$;
RESET ROLE;

-- Verify persisted read state remains owner-specific.
DO $assert_final_state$
BEGIN
  IF (SELECT read_at IS NULL FROM public.powerhub_user_notifications WHERE id=1001)
     OR (SELECT read_at IS NULL FROM public.powerhub_user_notifications WHERE id=1002)
     OR (SELECT read_at IS NULL FROM public.powerhub_user_notifications WHERE id=2001)
     OR (SELECT read_at IS NOT NULL FROM public.powerhub_user_notifications WHERE id=3001) THEN
    RAISE EXCEPTION 'NOTIFICATION_READ_STATE_CROSSED_USER_BOUNDARY';
  END IF;
END
$assert_final_state$;

SET ROLE anon;
DO $anon_denied$
DECLARE
  v record;
  v_denied boolean;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('list','SELECT public.powerhub_notification_list(100)'),
      ('unread_count','SELECT public.powerhub_notification_unread_count()'),
      ('mark_read','SELECT public.powerhub_notification_mark_read(1001)'),
      ('mark_all_read','SELECT public.powerhub_notification_mark_all_read()')
    ) AS calls(name,sql)
  LOOP
    v_denied:=false;
    BEGIN
      EXECUTE v.sql;
    EXCEPTION WHEN insufficient_privilege THEN
      v_denied:=true;
    END;
    IF NOT v_denied THEN
      RAISE EXCEPTION 'ANON_NOTIFICATION_RPC_WAS_ALLOWED: %',v.name;
    END IF;
  END LOOP;
END
$anon_denied$;
RESET ROLE;

SELECT 'notification RPC user ownership, active identity, JWT, and browser ACL tests passed' AS result;
