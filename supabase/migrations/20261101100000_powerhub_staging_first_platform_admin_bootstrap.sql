-- One-time, identity-bound bootstrap for the explicitly approved Staging test operator.
-- The exact Auth UUID and Staging-only email make this a no-op in Production,
-- where read-only verification on 2026-11-01 found no matching Auth identity.
-- Never generalize this migration into a reusable role-grant function.

DO $staging_first_platform_admin$
DECLARE
  v_expected_auth_user_id constant uuid := '8a594902-3521-4276-9bed-f6f53c8ee838';
  v_expected_email constant text := 'support.e2e@powerhub-staging.example.com';
  v_expected_name constant text := 'Support E2E Operator';
  v_auth_user auth.users%rowtype;
  v_target public.users%rowtype;
  v_target_count integer;
  v_other_active_admin_count integer;
  v_updated_rows integer;
BEGIN
  -- Fail closed unless this exact, confirmed Staging Auth identity exists.
  SELECT *
    INTO v_auth_user
    FROM auth.users
   WHERE id = v_expected_auth_user_id;

  IF NOT FOUND THEN
    RAISE NOTICE 'Staging bootstrap skipped: approved Auth identity is absent.';
    RETURN;
  END IF;

  -- The email check makes an accidental copy into another project a no-op.
  IF lower(coalesce(v_auth_user.email, '')) <> v_expected_email THEN
    RAISE NOTICE 'Staging bootstrap skipped: Auth identity email does not match the Staging fixture.';
    RETURN;
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
    RAISE NOTICE 'Staging bootstrap skipped: application profile is absent.';
    RETURN;
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

  -- Replays after a successful application are harmless and do not create
  -- duplicate audit entries or modify the already-established account.
  IF v_target.role = 'admin'
     AND v_target.platform_role = 'platform_admin'
     AND v_target.account_status = 'active' THEN
    RAISE NOTICE 'Staging bootstrap already completed; no change made.';
    RETURN;
  END IF;

  -- Only the observed mismatch is eligible: tenant-level user + platform_admin
  -- label + active account. Every other state must be reviewed manually.
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

  -- This is a system/release bootstrap, not a fabricated user-initiated action.
  -- created_by_user_id therefore remains NULL; the affected user is explicit.
  INSERT INTO public.platform_security_events (
    event_type,
    severity,
    status,
    title,
    details,
    metadata,
    related_user_id,
    created_by_user_id,
    created_at,
    updated_at
  ) VALUES (
    'security_change',
    'warning',
    'success',
    'تهيئة أول حساب إدارة منصة في Staging',
    'تم تحويل الدور التطبيقي للحساب الاختباري المعتمد من user إلى admin مع الإبقاء على platform_admin والحالة النشطة. لم تتغير بيانات المصادقة أو كلمة المرور أو العضويات.',
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
END
$staging_first_platform_admin$;
