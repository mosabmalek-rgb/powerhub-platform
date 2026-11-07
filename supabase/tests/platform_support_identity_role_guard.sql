\set ON_ERROR_STOP on

-- Disposable PostgreSQL regression fixture for platform-support identity.
-- Imports the exact migration and never accesses a deployed Supabase project.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$roles$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $uid$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$uid$;

CREATE TABLE public.users (
  id bigint PRIMARY KEY, auth_user_id uuid NOT NULL UNIQUE,
  role text NOT NULL, platform_role text NOT NULL, account_status text NOT NULL
);
CREATE TABLE private.platform_capability_policies (
  platform_role text NOT NULL, capability text NOT NULL, is_allowed boolean NOT NULL,
  PRIMARY KEY (platform_role, capability)
);
INSERT INTO public.users VALUES
 (1,'00000000-0000-0000-0000-000000000001','admin','platform_support','active'),
 (2,'00000000-0000-0000-0000-000000000002','member','platform_support','active'),
 (3,'00000000-0000-0000-0000-000000000003','admin','platform_admin','inactive'),
 (4,'00000000-0000-0000-0000-000000000004','admin','tenant_manager','active'),
 (5,'00000000-0000-0000-0000-000000000005','admin','platform_admin','active'),
 (6,'00000000-0000-0000-0000-000000000006','admin','finance_admin','active');
INSERT INTO private.platform_capability_policies VALUES
 ('platform_support','manageSupportChat',true),
 ('platform_admin','manageSupportChat',true),
 ('tenant_manager','manageSupportChat',true),
 ('finance_admin','viewFinance',true),
 ('finance_admin','manageSupportChat',false);

-- Reproduce the old predicate so the migration must actually harden it.
CREATE OR REPLACE FUNCTION private.powerhub_has_platform_capability(p_capability text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $function$
 SELECT EXISTS (
   SELECT 1 FROM public.users u
   JOIN private.platform_capability_policies policy
     ON policy.platform_role=u.platform_role AND policy.capability=p_capability AND policy.is_allowed=true
   WHERE u.auth_user_id=(SELECT auth.uid()) AND u.account_status='active'
     AND u.platform_role IN ('platform_owner','platform_admin','finance_admin','platform_support')
 );
$function$;
ALTER FUNCTION private.powerhub_has_platform_capability(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.powerhub_has_platform_capability(text) FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA auth,private TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT EXECUTE ON FUNCTION private.powerhub_has_platform_capability(text) TO authenticated;

\ir ../migrations/20261107130443_powerhub_platform_support_identity_role_guard.sql

GRANT USAGE ON SCHEMA public TO authenticated;
SET ROLE authenticated;
DO $identity_assertions$
DECLARE actual boolean;
BEGIN
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
 actual:=private.powerhub_has_platform_capability('manageSupportChat');
 IF actual IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACTIVE_PLATFORM_SUPPORT_ADMIN_WAS_DENIED'; END IF;

 PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
 actual:=private.powerhub_has_platform_capability('manageSupportChat');
 IF actual IS DISTINCT FROM false THEN RAISE EXCEPTION 'NON_ADMIN_PLATFORM_ROLE_ESCALATION_NOT_BLOCKED'; END IF;

 PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
 actual:=private.powerhub_has_platform_capability('manageSupportChat');
 IF actual IS DISTINCT FROM false THEN RAISE EXCEPTION 'INACTIVE_PLATFORM_ADMIN_WAS_AUTHORIZED'; END IF;

 PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
 actual:=private.powerhub_has_platform_capability('manageSupportChat');
 IF actual IS DISTINCT FROM false THEN RAISE EXCEPTION 'UNALLOWLISTED_PLATFORM_ROLE_WAS_AUTHORIZED'; END IF;

 PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000005',false);
 actual:=private.powerhub_has_platform_capability('manageSupportChat');
 IF actual IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACTIVE_PLATFORM_ADMIN_CAPABILITY_WAS_DENIED'; END IF;

 PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000006',false);
 actual:=private.powerhub_has_platform_capability('viewFinance');
 IF actual IS DISTINCT FROM true THEN RAISE EXCEPTION 'ACTIVE_FINANCE_ADMIN_CAPABILITY_WAS_DENIED'; END IF;
 actual:=private.powerhub_has_platform_capability('manageSupportChat');
 IF actual IS DISTINCT FROM false THEN RAISE EXCEPTION 'UNGRANTED_FINANCE_ADMIN_CAPABILITY_WAS_AUTHORIZED'; END IF;
END
$identity_assertions$;
RESET ROLE;

DO $catalog_assertions$
DECLARE v_oid oid:=to_regprocedure('private.powerhub_has_platform_capability(text)');
BEGIN
 IF v_oid IS NULL
    OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
    OR (SELECT proconfig FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM ARRAY['search_path=""']::text[]
    OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=v_oid))<>'postgres'
    OR has_function_privilege('anon',v_oid,'EXECUTE')
    OR NOT has_function_privilege('authenticated',v_oid,'EXECUTE')
    OR EXISTS (
      SELECT 1 FROM aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid=v_oid),acldefault('f',(SELECT proowner FROM pg_proc WHERE oid=v_oid)))) acl
      WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
    ) THEN
   RAISE EXCEPTION 'PLATFORM_SUPPORT_IDENTITY_FUNCTION_BOUNDARY_MISMATCH';
 END IF;
END
$catalog_assertions$;
SELECT 'PLATFORM_SUPPORT_IDENTITY_ROLE_GUARD_PASSED' AS result;
