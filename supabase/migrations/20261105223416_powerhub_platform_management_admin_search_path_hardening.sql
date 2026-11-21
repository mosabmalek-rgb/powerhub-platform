-- The helper is called from authenticated RLS policies. Its body already
-- schema-qualifies every relation and internal helper, so an empty search_path
-- removes temporary/public schema resolution from this SECURITY DEFINER boundary.
DO $preflight$
BEGIN
  IF to_regprocedure('private.powerhub_is_platform_management_admin()') IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_MANAGEMENT_ADMIN_HELPER_MISSING';
  END IF;
END
$preflight$;

ALTER FUNCTION private.powerhub_is_platform_management_admin() SET search_path = '';

DO $assertions$
DECLARE
  v_owner text;
  v_config text[];
  v_security_definer boolean;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner),p.proconfig,p.prosecdef
    INTO v_owner,v_config,v_security_definer
  FROM pg_catalog.pg_proc p
  WHERE p.oid='private.powerhub_is_platform_management_admin()'::regprocedure;

  IF v_owner <> 'postgres'
     OR NOT v_security_definer
     OR v_config IS DISTINCT FROM ARRAY['search_path=""']::text[] THEN
    RAISE EXCEPTION 'PLATFORM_MANAGEMENT_ADMIN_SEARCH_PATH_OWNER_OR_CONFIG_MISMATCH';
  END IF;

  IF has_function_privilege('anon','private.powerhub_is_platform_management_admin()','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_is_platform_management_admin()','EXECUTE')
     OR NOT has_function_privilege('service_role','private.powerhub_is_platform_management_admin()','EXECUTE') THEN
    RAISE EXCEPTION 'PLATFORM_MANAGEMENT_ADMIN_EXECUTE_ACL_MISMATCH';
  END IF;
END
$assertions$;
