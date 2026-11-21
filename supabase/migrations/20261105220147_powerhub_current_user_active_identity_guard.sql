-- Reject locked/suspended accounts at the RLS identity helper boundary.
-- These helpers are used directly by self-scoped notification and chat policies.
-- Requiring account_status='active' prevents a still-valid JWT from retaining
-- database-level self-row access after an administrative account lock.

DO $preflight$
BEGIN
  IF to_regprocedure('powerhub_private.current_user_id()') IS NULL
     OR to_regprocedure('private.powerhub_current_user_id()') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_IDENTITY_HELPER_DEPENDENCY_MISSING';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION powerhub_private.current_user_id()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT u.id
  FROM public.users u
  WHERE u.auth_user_id = (SELECT auth.uid())
    AND u.account_status = 'active'
  LIMIT 1;
$function$;
ALTER FUNCTION powerhub_private.current_user_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION powerhub_private.current_user_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION powerhub_private.current_user_id() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.powerhub_current_user_id()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT u.id
  FROM public.users u
  WHERE u.auth_user_id = (SELECT auth.uid())
    AND u.account_status = 'active'
  LIMIT 1;
$function$;
ALTER FUNCTION private.powerhub_current_user_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.powerhub_current_user_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.powerhub_current_user_id() TO authenticated, service_role;

COMMENT ON FUNCTION powerhub_private.current_user_id() IS
  'Returns the database user id for auth.uid() only while the corresponding PowerHub account is active; used by self-scoped RLS and Realtime policies.';
COMMENT ON FUNCTION private.powerhub_current_user_id() IS
  'Returns the database user id for auth.uid() only while the corresponding PowerHub account is active; used by self-scoped RLS policies.';

DO $assertions$
DECLARE
  v_powerhub_owner text;
  v_private_owner text;
  v_powerhub_config text[];
  v_private_config text[];
BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner),p.proconfig
    INTO v_powerhub_owner,v_powerhub_config
  FROM pg_catalog.pg_proc p
  WHERE p.oid='powerhub_private.current_user_id()'::regprocedure;

  SELECT pg_catalog.pg_get_userbyid(p.proowner),p.proconfig
    INTO v_private_owner,v_private_config
  FROM pg_catalog.pg_proc p
  WHERE p.oid='private.powerhub_current_user_id()'::regprocedure;

  IF v_powerhub_owner <> 'postgres'
     OR v_private_owner <> 'postgres'
     OR v_powerhub_config IS DISTINCT FROM ARRAY['search_path=""']::text[]
     OR v_private_config IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
    RAISE EXCEPTION 'ACTIVE_IDENTITY_HELPER_OWNER_OR_SEARCH_PATH_MISMATCH';
  END IF;

  IF has_function_privilege('anon','powerhub_private.current_user_id()','EXECUTE')
     OR has_function_privilege('anon','private.powerhub_current_user_id()','EXECUTE')
     OR NOT has_function_privilege('authenticated','powerhub_private.current_user_id()','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_current_user_id()','EXECUTE')
     OR NOT has_function_privilege('service_role','powerhub_private.current_user_id()','EXECUTE')
     OR NOT has_function_privilege('service_role','private.powerhub_current_user_id()','EXECUTE') THEN
    RAISE EXCEPTION 'ACTIVE_IDENTITY_HELPER_ACL_MISMATCH';
  END IF;
END
$assertions$;
