-- Restrict employee-profile capability overrides and their audit trail
-- to profiles visible in the caller's assigned branch scope.
DO $preflight$
BEGIN
  IF to_regclass('public.staff_profiles') IS NULL
     OR to_regclass('public.staff_profile_capability_overrides') IS NULL
     OR to_regclass('public.staff_profile_permission_audit') IS NULL
     OR to_regprocedure('private.powerhub_has_site_access(bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'STAFF_PROFILE_BRANCH_SCOPE_DEPENDENCY_MISSING';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION private.powerhub_has_staff_profile_site_access(
  target_tenant_id bigint,
  target_profile_id bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_profiles profile
    WHERE profile.tenant_id = target_tenant_id
      AND profile.id = target_profile_id
      AND private.powerhub_has_site_access(profile.tenant_id, profile.site_id)
  );
$function$;

ALTER FUNCTION private.powerhub_has_staff_profile_site_access(bigint,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.powerhub_has_staff_profile_site_access(bigint,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.powerhub_has_staff_profile_site_access(bigint,bigint) TO authenticated, service_role;

DROP POLICY IF EXISTS staff_profile_capability_overrides_site_scope_guard
  ON public.staff_profile_capability_overrides;
CREATE POLICY staff_profile_capability_overrides_site_scope_guard
  ON public.staff_profile_capability_overrides
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (private.powerhub_has_staff_profile_site_access(tenant_id, profile_id));

DROP POLICY IF EXISTS staff_profile_permission_audit_site_scope_guard
  ON public.staff_profile_permission_audit;
CREATE POLICY staff_profile_permission_audit_site_scope_guard
  ON public.staff_profile_permission_audit
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (private.powerhub_has_staff_profile_site_access(tenant_id, profile_id));

DO $assertions$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname='public' AND tablename='staff_profile_capability_overrides'
      AND policyname='staff_profile_capability_overrides_site_scope_guard'
      AND permissive='RESTRICTIVE' AND cmd='SELECT'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname='public' AND tablename='staff_profile_permission_audit'
      AND policyname='staff_profile_permission_audit_site_scope_guard'
      AND permissive='RESTRICTIVE' AND cmd='SELECT'
  ) THEN RAISE EXCEPTION 'STAFF_PROFILE_BRANCH_SCOPE_POLICY_MISSING'; END IF;

  IF has_function_privilege('anon','private.powerhub_has_staff_profile_site_access(bigint,bigint)','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_has_staff_profile_site_access(bigint,bigint)','EXECUTE')
     OR NOT has_function_privilege('service_role','private.powerhub_has_staff_profile_site_access(bigint,bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'STAFF_PROFILE_BRANCH_SCOPE_HELPER_ACL_FAILED';
  END IF;
END
$assertions$;
