-- Align database platform-capability identity with server/platform-admin.ts.
-- A platform_role value alone is not sufficient: only an active users.role='admin'
-- account with an allowlisted platform role may use the platform capability resolver.
DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('private.platform_capability_policies') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('private.powerhub_has_platform_capability(text)') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_PLATFORM_SUPPORT_IDENTITY_DEPENDENCY_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'
      AND column_name IN ('auth_user_id','role','platform_role','account_status')
    GROUP BY table_schema,table_name
    HAVING count(*)=4
  ) THEN
    RAISE EXCEPTION 'POWERHUB_PLATFORM_SUPPORT_IDENTITY_COLUMNS_MISSING';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION private.powerhub_has_platform_capability(p_capability text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN private.platform_capability_policies policy
      ON policy.platform_role = u.platform_role
     AND policy.capability = p_capability
     AND policy.is_allowed = true
    WHERE u.auth_user_id = (SELECT auth.uid())
      AND u.role = 'admin'
      AND u.account_status = 'active'
      AND u.platform_role IN ('platform_owner','platform_admin','finance_admin','platform_support')
  );
$function$;

ALTER FUNCTION private.powerhub_has_platform_capability(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.powerhub_has_platform_capability(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.powerhub_has_platform_capability(text) TO authenticated;

COMMENT ON FUNCTION private.powerhub_has_platform_capability(text) IS
  'Explicit platform capability resolver. Identity is derived only from auth.uid(); requires an active users.role=admin identity with an allowlisted platform role and an explicit capability policy.';

DO $postflight$
DECLARE
  v_oid oid := to_regprocedure('private.powerhub_has_platform_capability(text)');
BEGIN
  IF v_oid IS NULL
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM ARRAY['search_path=""']::text[]
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=v_oid)) <> 'postgres'
     OR has_function_privilege('anon',v_oid,'EXECUTE')
     OR NOT has_function_privilege('authenticated',v_oid,'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=v_oid), acldefault('f',(SELECT proowner FROM pg_proc WHERE oid=v_oid)))) acl
       WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'POWERHUB_PLATFORM_SUPPORT_IDENTITY_HELPER_BOUNDARY_MISMATCH';
  END IF;
END
$postflight$;
