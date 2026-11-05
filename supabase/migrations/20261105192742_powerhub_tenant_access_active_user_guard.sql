-- Tenant-level RLS must reject disabled/locked accounts even when their
-- tenant_members row remains active and their JWT has not yet expired.
DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.tenant_members') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('private.powerhub_current_user_id()') IS NULL
     OR to_regprocedure('private.powerhub_is_platform_admin()') IS NULL
     OR to_regprocedure('private.powerhub_has_tenant_access(bigint)') IS NULL THEN
    RAISE EXCEPTION 'TENANT_ACTIVE_USER_RLS_DEPENDENCY_MISSING';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION private.powerhub_has_tenant_access(target_tenant_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    (SELECT private.powerhub_is_platform_admin())
    OR (
      target_tenant_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.tenant_members membership
        JOIN public.users account
          ON account.id = membership.user_id
        WHERE membership.tenant_id = target_tenant_id
          AND membership.user_id = (SELECT private.powerhub_current_user_id())
          AND account.auth_user_id = (SELECT auth.uid())
          AND account.account_status = 'active'
          AND membership.is_active = true
          AND membership.membership_status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > pg_catalog.now())
      )
    );
$function$;

ALTER FUNCTION private.powerhub_has_tenant_access(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.powerhub_has_tenant_access(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.powerhub_has_tenant_access(bigint) TO authenticated, service_role;

COMMENT ON FUNCTION private.powerhub_has_tenant_access(bigint) IS
  'Tenant RLS predicate: requires the current auth.uid() to resolve to an active users row and an active, unexpired tenant membership; platform-admin bypass requires the separate active-admin predicate.';

DO $assertions$
DECLARE v_owner text; v_search_path text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner),
         coalesce((SELECT cfg FROM unnest(coalesce(p.proconfig,ARRAY[]::text[])) cfg
                   WHERE cfg LIKE 'search_path=%' LIMIT 1),'')
    INTO v_owner,v_search_path
  FROM pg_catalog.pg_proc p
  WHERE p.oid='private.powerhub_has_tenant_access(bigint)'::regprocedure;

  IF v_owner <> 'postgres' OR v_search_path <> 'search_path=""' THEN
    RAISE EXCEPTION 'TENANT_ACTIVE_USER_RLS_FUNCTION_HARDENING_FAILED: owner=%, search_path=%',v_owner,v_search_path;
  END IF;
  IF has_function_privilege('anon','private.powerhub_has_tenant_access(bigint)','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_has_tenant_access(bigint)','EXECUTE')
     OR NOT has_function_privilege('service_role','private.powerhub_has_tenant_access(bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'TENANT_ACTIVE_USER_RLS_FUNCTION_ACL_FAILED';
  END IF;
END
$assertions$;
