-- Align every tenant-RLS platform-admin bypass with the application identity contract.
-- A platform_role string alone is not an administrator identity. The server
-- requires users.role='admin', active account status, and an explicit allowlist.
-- Platform Support remains governed by private.powerhub_has_platform_capability
-- and does not receive blanket tenant-row visibility.

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.tenant_members') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regprocedure('powerhub_private.current_user_id()') IS NULL
     OR to_regprocedure('powerhub_private.is_platform_admin()') IS NULL
     OR to_regprocedure('powerhub_private.is_platform_user()') IS NULL
     OR to_regprocedure('private.powerhub_current_user_id()') IS NULL
     OR to_regprocedure('private.powerhub_is_platform_admin()') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_PLATFORM_IDENTITY_RLS_DEPENDENCY_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'
      AND column_name IN ('auth_user_id','role','platform_role','account_status')
    GROUP BY table_schema,table_name
    HAVING count(*)=4
  ) THEN
    RAISE EXCEPTION 'POWERHUB_PLATFORM_IDENTITY_COLUMNS_MISSING';
  END IF;
END
$preflight$;

-- The allowlist intentionally matches server/platform-admin.ts exactly:
-- platform_owner, platform_admin and finance_admin require role='admin'.
CREATE OR REPLACE FUNCTION powerhub_private.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role = 'admin'
      AND u.platform_role IN ('platform_owner','platform_admin','finance_admin')
      AND u.account_status = 'active'
  );
$function$;
ALTER FUNCTION powerhub_private.is_platform_admin() OWNER TO postgres;

-- Historical tenant policies use is_platform_user() as their cross-tenant
-- administrator exception. Keep the signature for compatibility, but make
-- its meaning the same strict administrator check. Support must use a separate
-- explicit platform capability and is never a tenant-data bypass.
CREATE OR REPLACE FUNCTION powerhub_private.is_platform_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT powerhub_private.is_platform_admin();
$function$;
ALTER FUNCTION powerhub_private.is_platform_user() OWNER TO postgres;

-- The private helper backs older complaints/meters policies and must use the
-- identical identity rule. Do not change powerhub_is_platform_management_admin:
-- it is intentionally narrower and excludes finance_admin.
CREATE OR REPLACE FUNCTION private.powerhub_is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.auth_user_id = auth.uid()
      AND u.role = 'admin'
      AND u.platform_role IN ('platform_owner','platform_admin','finance_admin')
      AND u.account_status = 'active'
  );
$function$;
ALTER FUNCTION private.powerhub_is_platform_admin() OWNER TO postgres;

REVOKE ALL ON FUNCTION powerhub_private.is_platform_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION powerhub_private.is_platform_user() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.powerhub_is_platform_admin() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION powerhub_private.is_platform_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION powerhub_private.is_platform_user() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.powerhub_is_platform_admin() TO authenticated, service_role;

COMMENT ON FUNCTION powerhub_private.is_platform_admin() IS
  'Cross-tenant tenant-data bypass for active users with role=admin and platform_role in platform_owner/platform_admin/finance_admin. Mirrors server/platform-admin.ts.';
COMMENT ON FUNCTION powerhub_private.is_platform_user() IS
  'Legacy compatibility alias for the strict platform-admin tenant-data bypass. Platform Support must use explicit platform capabilities; platform_role presence alone is not authorization.';
COMMENT ON FUNCTION private.powerhub_is_platform_admin() IS
  'Cross-tenant tenant-data bypass matching server/platform-admin.ts: role=admin, active account, and allowlisted platform role.';
