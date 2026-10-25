-- Forward-only correction for platform-management authorization scope.
-- Keep the general platform-admin helper unchanged because finance_admin has
-- legitimate visibility in other workflows; use a narrower helper where the
-- application contract explicitly excludes finance_admin.
CREATE OR REPLACE FUNCTION private.powerhub_is_platform_management_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = private.powerhub_current_user_id()
      AND role = 'admin'
      AND platform_role IN ('platform_owner', 'platform_admin')
      AND account_status = 'active'
  );
$function$;
ALTER FUNCTION private.powerhub_is_platform_management_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.powerhub_is_platform_management_admin() FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.powerhub_is_platform_management_admin() TO authenticated, service_role;

-- Security logs/settings are exposed only to active platform owners/admins.
ALTER TABLE public.platform_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_security_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_security_events_platform_admin_only ON public.platform_security_events;
CREATE POLICY platform_security_events_platform_admin_only
  ON public.platform_security_events AS PERMISSIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_management_admin())
  WITH CHECK (private.powerhub_is_platform_management_admin());
DROP POLICY IF EXISTS platform_security_events_platform_admin_guard ON public.platform_security_events;
CREATE POLICY platform_security_events_platform_admin_guard
  ON public.platform_security_events AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_management_admin())
  WITH CHECK (private.powerhub_is_platform_management_admin());
DROP POLICY IF EXISTS platform_security_settings_platform_admin_only ON public.platform_security_settings;
CREATE POLICY platform_security_settings_platform_admin_only
  ON public.platform_security_settings AS PERMISSIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_management_admin())
  WITH CHECK (private.powerhub_is_platform_management_admin());
DROP POLICY IF EXISTS platform_security_settings_platform_admin_guard ON public.platform_security_settings;
CREATE POLICY platform_security_settings_platform_admin_guard
  ON public.platform_security_settings AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_management_admin())
  WITH CHECK (private.powerhub_is_platform_management_admin());

-- Access-recovery requests contain security workflow metadata and are read by
-- the platform-management server workflow only; tenant members get no direct read.
ALTER TABLE public.access_recovery_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_recovery_tenant_isolation ON public.access_recovery_requests;
CREATE POLICY access_recovery_tenant_isolation
  ON public.access_recovery_requests AS PERMISSIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_management_admin())
  WITH CHECK (private.powerhub_is_platform_management_admin());
DROP POLICY IF EXISTS access_recovery_scope_guard ON public.access_recovery_requests;
CREATE POLICY access_recovery_scope_guard
  ON public.access_recovery_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING (private.powerhub_is_platform_management_admin())
  WITH CHECK (private.powerhub_is_platform_management_admin());

-- Quick-action preferences stay owner-scoped; only platform owners/admins may
-- inspect or manage other users' preferences from the platform workspace.
ALTER TABLE public.user_quick_action_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quick_actions_owner_only ON public.user_quick_action_preferences;
CREATE POLICY quick_actions_owner_only
  ON public.user_quick_action_preferences AS PERMISSIVE FOR ALL TO authenticated
  USING (user_id = private.powerhub_current_user_id() OR private.powerhub_is_platform_management_admin())
  WITH CHECK (user_id = private.powerhub_current_user_id() OR private.powerhub_is_platform_management_admin());
DROP POLICY IF EXISTS quick_actions_owner_guard ON public.user_quick_action_preferences;
CREATE POLICY quick_actions_owner_guard
  ON public.user_quick_action_preferences AS RESTRICTIVE FOR ALL TO authenticated
  USING (user_id = private.powerhub_current_user_id() OR private.powerhub_is_platform_management_admin())
  WITH CHECK (user_id = private.powerhub_current_user_id() OR private.powerhub_is_platform_management_admin());
