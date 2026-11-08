-- Harden field-user quota enforcement without replaying historical migrations.
-- This migration is source-only until independently approved for Staging.
-- The previous guard can reject an UPDATE of an existing active technician when
-- the tenant is exactly at quota, because its distinct-user count includes NEW
-- while its "existing" check excludes the same staff_profiles row.
-- Serialize new active-technician admissions for each tenant to prevent
-- concurrent inserts/role changes from both accepting the final slot.

DO $preflight$
BEGIN
  IF to_regclass('public.staff_profiles') IS NULL
     OR to_regprocedure('public.powerhub_enforce_field_user_quota()') IS NULL
     OR to_regprocedure('public.powerhub_resolve_tenant_feature_policy(bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'FIELD_USER_POLICY_GUARD_DEPENDENCIES_MISSING';
  END IF;
  IF (SELECT p.prosecdef IS NOT TRUE OR pg_get_userbyid(p.proowner) <> 'postgres'
      FROM pg_proc p
      WHERE p.oid='public.powerhub_enforce_field_user_quota()'::regprocedure) THEN
    RAISE EXCEPTION 'FIELD_USER_POLICY_GUARD_OWNER_OR_SECURITY_DRIFT';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.powerhub_enforce_field_user_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $guard$
DECLARE
  v_policy record;
  v_existing boolean := false;
BEGIN
  IF NEW.role <> 'technician' OR NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Protect the read-count/permit sequence across simultaneous INSERTs and
  -- UPDATEs for the same tenant (distinct tenant identities remain independent).
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('powerhub:field_users'),
    pg_catalog.hashtext(NEW.tenant_id::text)
  );

  SELECT * INTO v_policy
  FROM public.powerhub_resolve_tenant_feature_policy(NEW.tenant_id, 'field_users');

  IF NOT FOUND OR NOT coalesce(v_policy.eligible, false)
     OR NOT coalesce(v_policy.enabled, false) THEN
    RAISE EXCEPTION 'FIELD_USERS_FEATURE_DISABLED' USING ERRCODE = 'P0001';
  END IF;

  IF v_policy.effective_limit IS NULL THEN
    RETURN NEW;
  END IF;

  -- A second active staff profile for the same tenant/user does not consume a
  -- new distinct-user slot. An UPDATE of the same active technician also does
  -- not consume another slot, even when the quota is already fully occupied.
  SELECT EXISTS(
    SELECT 1
    FROM public.staff_profiles p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.user_id = NEW.user_id
      AND p.role = 'technician'
      AND p.is_active = true
      AND p.id <> coalesce(NEW.id, 0)
  ) INTO v_existing;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.tenant_id = NEW.tenant_id
       AND OLD.user_id = NEW.user_id
       AND OLD.role = 'technician'
       AND OLD.is_active IS TRUE THEN
      v_existing := true;
    END IF;
  END IF;

  IF NOT v_existing AND (
    SELECT count(DISTINCT p.user_id)
    FROM public.staff_profiles p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.role = 'technician'
      AND p.is_active = true
  ) >= v_policy.effective_limit THEN
    RAISE EXCEPTION 'FIELD_USER_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION public.powerhub_enforce_field_user_quota()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_enforce_field_user_quota()
  TO service_role;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid='public.staff_profiles'::regclass
      AND t.tgfoid='public.powerhub_enforce_field_user_quota()'::regprocedure
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'FIELD_USER_POLICY_GUARD_TRIGGER_NOT_ATTACHED';
  END IF;
  IF has_function_privilege('anon',
         'public.powerhub_enforce_field_user_quota()','EXECUTE')
     OR has_function_privilege('authenticated',
         'public.powerhub_enforce_field_user_quota()','EXECUTE')
     OR NOT has_function_privilege('service_role',
         'public.powerhub_enforce_field_user_quota()','EXECUTE') THEN
    RAISE EXCEPTION 'FIELD_USER_POLICY_GUARD_ACL_POSTFLIGHT_FAILED';
  END IF;
END
$postflight$;
