-- One-time, identity-bound transfer of the sole Staging platform-admin role.
-- Exact Auth UUIDs/emails and profile names prevent accidental use in Production
-- or against a different account. This migration performs the approved transfer
-- atomically, records a system-origin audit event, then removes RPC execute access.

CREATE OR REPLACE FUNCTION public.powerhub_staging_transfer_platform_admin_to_known_e2e_account()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $function$
DECLARE
  v_source_auth_id CONSTANT uuid := '8a594902-3521-4276-9bed-f6f53c8ee838';
  v_target_auth_id CONSTANT uuid := '88de50da-7aab-46cc-a037-6410bcf4a3ed';
  v_source_email CONSTANT text := 'support.e2e@powerhub-staging.example.com';
  v_source_name CONSTANT text := 'Support E2E Operator';
  v_target_email CONSTANT text := 'powerhub.e2e.test@gmail.com';
  v_target_name CONSTANT text := 'powerhub.e2e.test';
  v_source_auth auth.users%rowtype;
  v_target_auth auth.users%rowtype;
  v_source public.users%rowtype;
  v_target public.users%rowtype;
  v_count integer;
  v_updated integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('powerhub-staging-platform-admin-transfer-20261101', 0));

  SELECT * INTO v_source_auth FROM auth.users WHERE id = v_source_auth_id FOR UPDATE;
  SELECT * INTO v_target_auth FROM auth.users WHERE id = v_target_auth_id FOR UPDATE;

  IF NOT FOUND AND v_target_auth.id IS NULL THEN
    RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_AUTH_IDENTITY_MISSING';
  END IF;
  IF v_source_auth.id IS NULL
     OR lower(coalesce(v_source_auth.email, '')) <> v_source_email
     OR v_target_auth.id IS NULL
     OR lower(coalesce(v_target_auth.email, '')) <> v_target_email THEN
    RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_AUTH_IDENTITY_MISMATCH';
  END IF;
  IF v_source_auth.email_confirmed_at IS NULL
     OR (v_source_auth.banned_until IS NOT NULL AND v_source_auth.banned_until > now())
     OR v_target_auth.email_confirmed_at IS NULL
     OR (v_target_auth.banned_until IS NOT NULL AND v_target_auth.banned_until > now()) THEN
    RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_AUTH_ACCOUNT_NOT_ELIGIBLE';
  END IF;

  SELECT count(*) INTO v_count FROM public.users WHERE auth_user_id = v_source_auth_id;
  IF v_count <> 1 THEN RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_SOURCE_PROFILE_NOT_UNIQUE'; END IF;
  SELECT count(*) INTO v_count FROM public.users WHERE auth_user_id = v_target_auth_id;
  IF v_count <> 1 THEN RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_TARGET_PROFILE_NOT_UNIQUE'; END IF;

  SELECT * INTO v_source FROM public.users WHERE auth_user_id = v_source_auth_id FOR UPDATE;
  SELECT * INTO v_target FROM public.users WHERE auth_user_id = v_target_auth_id FOR UPDATE;

  IF v_source.name IS DISTINCT FROM v_source_name
     OR lower(coalesce(v_source.email, '')) <> v_source_email
     OR v_source.role IS DISTINCT FROM 'admin'
     OR v_source.platform_role IS DISTINCT FROM 'platform_admin'
     OR v_source.account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_SOURCE_STATE_MISMATCH';
  END IF;
  IF v_target.name IS DISTINCT FROM v_target_name
     OR lower(coalesce(v_target.email, '')) <> v_target_email
     OR v_target.role IS DISTINCT FROM 'user'
     OR v_target.platform_role IS NOT NULL
     OR v_target.account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_TARGET_STATE_MISMATCH';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.users u
   WHERE u.role = 'admin'
     AND u.account_status = 'active'
     AND u.platform_role IN ('platform_owner', 'platform_admin');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_EXPECTED_EXACTLY_ONE_ACTIVE_PLATFORM_ADMIN';
  END IF;

  -- Preserve tenant memberships. The previous bootstrap account was verified to have none.
  SELECT count(*) INTO v_count FROM public.tenant_members WHERE user_id = v_source.id;
  IF v_count <> 0 THEN RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_SOURCE_HAS_TENANT_MEMBERSHIPS'; END IF;

  UPDATE public.users
     SET role = 'admin', platform_role = 'platform_admin', updated_at = now()
   WHERE id = v_target.id AND auth_user_id = v_target_auth_id
     AND role = 'user' AND platform_role IS NULL AND account_status = 'active';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_TARGET_UPDATE_FAILED'; END IF;

  UPDATE public.users
     SET role = 'user', platform_role = NULL, updated_at = now()
   WHERE id = v_source.id AND auth_user_id = v_source_auth_id
     AND role = 'admin' AND platform_role = 'platform_admin' AND account_status = 'active';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_SOURCE_UPDATE_FAILED'; END IF;

  INSERT INTO public.platform_security_events (
    event_type, severity, status, title, details, metadata,
    related_user_id, created_by_user_id, created_at, updated_at
  ) VALUES (
    'security_change', 'warning', 'success',
    'نقل صلاحية إدارة المنصة في Staging إلى حساب E2E المعروف',
    'تم نقل صلاحية مدير المنصة من Support E2E Operator إلى حساب E2E المعتمد. لم تتغير بيانات Auth أو كلمات المرور أو عضويات المستأجر.',
    jsonb_build_object(
      'event', 'staging_platform_admin_transfer',
      'environment', 'staging',
      'authorization', 'explicit_user_approval_in_chat',
      'sourceAuthUserId', v_source_auth_id,
      'targetAuthUserId', v_target_auth_id,
      'sourcePreviousRole', 'admin',
      'sourceResultingRole', 'user',
      'targetPreviousRole', 'user',
      'targetResultingRole', 'admin',
      'targetPreviousPlatformRole', NULL,
      'targetResultingPlatformRole', 'platform_admin',
      'authCredentialsChanged', false,
      'passwordChanged', false,
      'tenantMembershipsChanged', false
    ),
    v_target.id, NULL, now(), now()
  );

  RETURN 'transferred';
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_staging_transfer_platform_admin_to_known_e2e_account() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_staging_transfer_platform_admin_to_known_e2e_account() TO service_role;

DO $transfer$
BEGIN
  IF public.powerhub_staging_transfer_platform_admin_to_known_e2e_account() <> 'transferred' THEN
    RAISE EXCEPTION 'STAGING_ADMIN_TRANSFER_UNEXPECTED_RESULT';
  END IF;
END
$transfer$;

REVOKE ALL ON FUNCTION public.powerhub_staging_transfer_platform_admin_to_known_e2e_account() FROM PUBLIC, anon, authenticated, service_role;
