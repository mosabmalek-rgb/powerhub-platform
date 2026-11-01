-- One-time, identity-bound bootstrap RPC for the explicitly approved Staging test operator.
-- The exact Auth UUID and Staging-only email make this a no-op in Production,
-- where read-only verification on 2026-11-01 found no matching Auth identity.
-- This migration defines a server-only operation; it does not promote anyone
-- merely by being applied. Invoke the RPC only after the protected Staging release.

CREATE OR REPLACE FUNCTION public.powerhub_staging_bootstrap_first_platform_admin()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $function$
DECLARE
  v_expected_auth_user_id CONSTANT uuid := '8a594902-3521-4276-9bed-f6f53c8ee838';
  v_expected_email CONSTANT text := 'support.e2e@powerhub-staging.example.com';
  v_expected_name CONSTANT text := 'Support E2E Operator';
  v_auth_user auth.users%rowtype;
  v_target public.users%rowtype;
  v_target_count integer;
  v_other_active_admin_count integer;
  v_updated_rows integer;
BEGIN
  -- Serialize the one-time bootstrap across retries and concurrent callers.
  PERFORM pg_advisory_xact_lock(hashtextextended('powerhub-staging-first-platform-admin-bootstrap', 0));

  SELECT *
    INTO v_auth_user
    FROM auth.users
   WHERE id = v_expected_auth_user_id
   FOR UPDATE;

  IF NOT FOUND OR lower(coalesce(v_auth_user.email, '')) <> v_expected_email THEN
    RETURN 'skipped_non_staging_identity';
  END IF;

  IF v_auth_user.email_confirmed_at IS NULL
     OR (v_auth_user.banned_until IS NOT NULL AND v_auth_user.banned_until > now()) THEN
    RAISE EXCEPTION 'STAGING_BOOTSTRAP_AUTH_ACCOUNT_NOT_ELIGIBLE';
  END IF;

  SELECT count(*)
    INTO v_target_count
    FROM public.users
   WHERE auth_user_id = v_expected_auth_user_id;

  IF v_target_count = 0 THEN
    RETURN 'skipped_missing_application_profile';
  END IF;
  IF v_target_count <> 1 THEN
    RAISE EXCEPTION 'STAGING_BOOTSTRAP_AUTH_PROFILE_NOT_UNIQUE';
  END IF;

  SELECT *
    INTO v_target
    FROM public.users
   WHERE auth_user_id = v_expected_auth_user_id
   FOR UPDATE;

  IF v_target.name IS DISTINCT FROM v_expected_name
     OR lower(coalesce(v_target.email, '')) <> v_expected_email THEN
    RAISE EXCEPTION 'STAGING_BOOTSTRAP_PROFILE_IDENTITY_MISMATCH';
  END IF;

  IF v_target.role = 'admin'
     AND v_target.platform_role = 'platform_admin'
     AND v_target.account_status = 'active' THEN
    RETURN 'already_bootstrapped';
  END IF;

  IF v_target.role IS DISTINCT FROM 'user'
     OR v_target.platform_role IS DISTINCT FROM 'platform_admin'
     OR v_target.account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'STAGING_BOOTSTRAP_PROFILE_STATE_MISMATCH';
  END IF;

  SELECT count(*)
    INTO v_other_active_admin_count
    FROM public.users u
   WHERE u.id <> v_target.id
     AND u.role = 'admin'
     AND u.account_status = 'active'
     AND u.platform_role IN ('platform_owner', 'platform_admin');

  IF v_other_active_admin_count <> 0 THEN
    RAISE EXCEPTION 'STAGING_BOOTSTRAP_ANOTHER_ACTIVE_PLATFORM_ADMIN_EXISTS';
  END IF;

  -- Change only the application-level role. Keep Auth credentials, user UUID,
  -- platform role, account status, memberships, and password flags untouched.
  UPDATE public.users
     SET role = 'admin',
         updated_at = now()
   WHERE id = v_target.id
     AND auth_user_id = v_expected_auth_user_id
     AND role = 'user'
     AND platform_role = 'platform_admin'
     AND account_status = 'active';

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'STAGING_BOOTSTRAP_UPDATE_DID_NOT_AFFECT_EXACTLY_ONE_PROFILE';
  END IF;

  -- System-origin event: no fictitious human actor is recorded.
  INSERT INTO public.platform_security_events (
    event_type, severity, status, title, details, metadata,
    related_user_id, created_by_user_id, created_at, updated_at
  ) VALUES (
    'security_change',
    'warning',
    'success',
    'تهيئة أول حساب إدارة منصة في Staging',
    'تم تفعيل حساب الإدارة الاختباري المعتمد عبر إجراء تهيئة خادمي لمرة واحدة. لم تتغير بيانات المصادقة أو كلمة المرور أو العضويات.',
    jsonb_build_object(
      'event', 'staging_first_platform_admin_bootstrap',
      'environment', 'staging',
      'authorization', 'approved_staging_bootstrap_operation',
      'migrationVersion', '20261101100000',
      'targetAuthUserId', v_expected_auth_user_id,
      'previousRole', 'user',
      'resultingRole', 'admin',
      'platformRole', 'platform_admin',
      'accountStatus', 'active',
      'authCredentialsChanged', false,
      'membershipsChanged', false,
      'passwordChanged', false
    ),
    v_target.id,
    NULL,
    now(),
    now()
  );

  RETURN 'bootstrapped';
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_staging_bootstrap_first_platform_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_staging_bootstrap_first_platform_admin() TO service_role;
