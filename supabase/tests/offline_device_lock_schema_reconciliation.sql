\set ON_ERROR_STOP on

DO $roles$
BEGIN
  BEGIN CREATE ROLE anon nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-000000000001');

\ir ../migrations/20261024210500_powerhub_device_lock_schema_reconciliation.sql
-- The release path must be safe to rerun against the reconciled schema.
\ir ../migrations/20261024210500_powerhub_device_lock_schema_reconciliation.sql

DO $assert_acl$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.powerhub_user_device_locks'::regclass) THEN
    RAISE EXCEPTION 'DEVICE_LOCK_RLS_NOT_ENABLED';
  END IF;
  IF has_table_privilege('anon','public.powerhub_user_device_locks','SELECT')
     OR has_table_privilege('authenticated','public.powerhub_user_device_locks','SELECT') THEN
    RAISE EXCEPTION 'DEVICE_LOCK_TABLE_READ_EXPOSED_TO_BROWSER_ROLE';
  END IF;
  IF NOT has_table_privilege('service_role','public.powerhub_user_device_locks','INSERT')
     OR NOT has_table_privilege('service_role','public.powerhub_user_device_locks','UPDATE')
     OR NOT has_table_privilege('service_role','public.powerhub_user_device_locks','DELETE') THEN
    RAISE EXCEPTION 'DEVICE_LOCK_SERVICE_ROLE_GRANTS_MISSING';
  END IF;
  IF has_function_privilege('anon','public.powerhub_claim_user_device(uuid,uuid,timestamptz)'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_claim_user_device(uuid,uuid,timestamptz)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.powerhub_claim_user_device(uuid,uuid,timestamptz)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'DEVICE_LOCK_CLAIM_RPC_ACL_INVALID';
  END IF;
  IF has_function_privilege('anon','public.powerhub_release_user_device(uuid,uuid)'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_release_user_device(uuid,uuid)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.powerhub_release_user_device(uuid,uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'DEVICE_LOCK_RELEASE_RPC_ACL_INVALID';
  END IF;
  IF position('pg_advisory_xact_lock' IN pg_get_functiondef('public.powerhub_claim_user_device(uuid,uuid,timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'DEVICE_LOCK_CLAIM_RPC_MISSING_TRANSACTION_ADVISORY_LOCK';
  END IF;
END
$assert_acl$;

DO $behavior$
DECLARE
  v_claim record;
  v_user uuid := '00000000-0000-0000-0000-000000000001';
  v_first_device uuid := '10000000-0000-0000-0000-000000000001';
  v_second_device uuid := '20000000-0000-0000-0000-000000000002';
BEGIN
  SELECT * INTO v_claim
  FROM public.powerhub_claim_user_device(v_user, v_first_device, now() + interval '48 hours');
  IF NOT v_claim.allowed OR v_claim.active_device_id <> v_first_device THEN
    RAISE EXCEPTION 'DEVICE_LOCK_FIRST_CLAIM_FAILED';
  END IF;

  SELECT * INTO v_claim
  FROM public.powerhub_claim_user_device(v_user, v_second_device, now() + interval '48 hours');
  IF v_claim.allowed OR v_claim.active_device_id <> v_first_device THEN
    RAISE EXCEPTION 'DEVICE_LOCK_ACTIVE_DEVICE_WAS_REPLACED';
  END IF;

  UPDATE public.powerhub_user_device_locks
  SET last_seen_at = now() - interval '16 minutes',
      updated_at = now() - interval '16 minutes'
  WHERE user_id = v_user;
  SELECT * INTO v_claim
  FROM public.powerhub_claim_user_device(v_user, v_second_device, now() + interval '48 hours');
  IF NOT v_claim.allowed OR v_claim.active_device_id <> v_second_device THEN
    RAISE EXCEPTION 'DEVICE_LOCK_STALE_RECOVERY_FAILED';
  END IF;

  UPDATE public.powerhub_user_device_locks
  SET locked_until = now() - interval '1 minute'
  WHERE user_id = v_user;
  SELECT * INTO v_claim
  FROM public.powerhub_claim_user_device(v_user, v_first_device, now() + interval '48 hours');
  IF NOT v_claim.allowed OR v_claim.active_device_id <> v_first_device THEN
    RAISE EXCEPTION 'DEVICE_LOCK_EXPIRED_RECOVERY_FAILED';
  END IF;

  IF public.powerhub_release_user_device(v_user, v_second_device) THEN
    RAISE EXCEPTION 'DEVICE_LOCK_RELEASED_DIFFERENT_DEVICE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.powerhub_user_device_locks
    WHERE user_id = v_user AND device_id = v_first_device
  ) THEN
    RAISE EXCEPTION 'DEVICE_LOCK_WRONG_DEVICE_RELEASE_REMOVED_ACTIVE_LOCK';
  END IF;
  IF NOT public.powerhub_release_user_device(v_user, v_first_device) THEN
    RAISE EXCEPTION 'DEVICE_LOCK_RELEASE_FAILED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.powerhub_user_device_locks WHERE user_id=v_user) THEN
    RAISE EXCEPTION 'DEVICE_LOCK_RELEASE_LEFT_ROW';
  END IF;
  IF public.powerhub_release_user_device(v_user, v_first_device) THEN
    RAISE EXCEPTION 'DEVICE_LOCK_RELEASE_NOT_IDEMPOTENT';
  END IF;
END
$behavior$;

SELECT 'device-lock schema reconciliation: ACL, advisory locking, single-device guard, stale/expired recovery and release passed' AS result;
