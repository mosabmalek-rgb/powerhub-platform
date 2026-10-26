\set ON_ERROR_STOP on

-- Disposable PostgreSQL fixture: recreate only the prerequisite relations needed to
-- compile/attach the reconciliation migration. No production or staging is accessed.
DO $roles$
BEGIN
  BEGIN CREATE ROLE anon nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role nologin; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $auth_uid$ SELECT NULL::uuid $auth_uid$;

CREATE TABLE public.users (
  id bigint PRIMARY KEY,
  auth_user_id uuid,
  name text,
  email text,
  login_method text,
  role text,
  platform_role text,
  account_status text,
  must_change_password boolean,
  temporary_password_issued_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  last_signed_in timestamptz
);
CREATE TABLE public.tenants (id bigint PRIMARY KEY, name text, slug text, status text);
CREATE TABLE public.tenant_members (
  id bigint PRIMARY KEY,
  tenant_id bigint NOT NULL,
  user_id bigint NOT NULL,
  role text,
  is_active boolean NOT NULL DEFAULT true,
  membership_status text NOT NULL DEFAULT 'active',
  expires_at timestamptz
);
CREATE TABLE public.sites (
  id bigint PRIMARY KEY, tenant_id bigint, name text, code text, status text, city text
);
CREATE TABLE public.subscribers (
  id bigint PRIMARY KEY, tenant_id bigint, site_id bigint, subscriber_no text,
  full_name text, phone text, address text, subscription_type text,
  service_status text, created_at timestamptz
);
CREATE TABLE public.generators (id bigint PRIMARY KEY, tenant_id bigint, site_id bigint);
CREATE TABLE public.tenant_subscriptions (
  id bigint PRIMARY KEY, tenant_id bigint, plan text, status text, billing_cycle text,
  started_at timestamptz, ends_at timestamptz, auto_renew boolean, renewal_count integer,
  last_renewed_at timestamptz, notes text, sms_plan_id bigint, created_at timestamptz,
  updated_at timestamptz, package_code text, trial_duration_days integer,
  cancelled_at timestamptz, cancelled_by_user_id bigint, cancellation_reason text,
  read_only_until timestamptz, archived_at timestamptz, archived_by_user_id bigint,
  archive_reason text
);
CREATE TABLE public.tenant_addon_requests (
  id bigint PRIMARY KEY, tenant_id bigint, site_id bigint, requested_by_user_id bigint,
  addon_code text, quantity integer, status text, note text, created_at timestamptz,
  reviewed_at timestamptz, reviewed_by_user_id bigint, review_note text,
  duration_days integer, starts_at timestamptz, ends_at timestamptz,
  renewed_from_request_id bigint, billing_mode text, source text, request_key uuid
);
CREATE TABLE public.offline_sync_operations (
  id bigint PRIMARY KEY, tenant_id bigint, site_id bigint, user_id bigint,
  client_operation_id text, operation_type text, entity_type text, entity_id text,
  response jsonb, created_at timestamptz
);
-- Deliberately model the staging drift: nullable scheduled_at without a default.
CREATE TABLE public.notification_messages (id bigint PRIMARY KEY, scheduled_at timestamptz);
CREATE TABLE public.feature_catalog (
  feature_key text PRIMARY KEY, is_active boolean, updated_at timestamptz
);
-- These security tables are prerequisites for the forward policy-scope migration.
CREATE TABLE public.platform_security_events (
  id bigint PRIMARY KEY, event_type text, severity text, status text, title text,
  details text, metadata jsonb, related_user_id bigint, created_by_user_id bigint,
  created_at timestamptz, resolved_at timestamptz
);
CREATE TABLE public.platform_security_settings (
  id bigint PRIMARY KEY, setting_key text, is_enabled boolean, value jsonb,
  updated_at timestamptz, updated_by_user_id bigint
);

CREATE OR REPLACE FUNCTION public.powerhub_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$function$;

-- The reconciliation removes obsolete overloads that were present only in drifted staging.
CREATE OR REPLACE FUNCTION public.powerhub_admin_request_owner_access_recovery(bigint,bigint,text)
RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb)
RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb,uuid)
RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

-- First pass must create missing tables, indexes, RLS policies, triggers, and production RPC signatures.
\ir ../migrations/20261025101753_powerhub_missing_schema_and_rpc_reconciliation.sql

-- Simulate legacy/staging-wide ACL drift deliberately, then prove the forward migration
-- can repair it on a second pass without duplicating policies/triggers/indexes.
DO $widen_table_acl$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'access_recovery_requests','complaints','feature_global_control_audit',
    'generator_owner_provisioning_operations','meters','password_reset_intents',
    'platform_tariff_policies','subscription_renewal_operations',
    'tenant_addon_renewal_decisions','tenant_owner_alerts','user_quick_action_preferences'
  ] LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO PUBLIC, anon, authenticated',v_table);
  END LOOP;
END
$widen_table_acl$;

DO $widen_function_acl$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'powerhub_admin_complete_generator_owner_provisioning',
      'powerhub_admin_create_tariff_policy',
      'powerhub_admin_grant_tenant_addon',
      'powerhub_admin_renew_subscription_idempotent',
      'powerhub_admin_renew_subscription_with_addons',
      'powerhub_admin_request_owner_access_recovery',
      'powerhub_admin_review_tenant_addon_request',
      'powerhub_admin_set_feature_global',
      'powerhub_admin_set_tenant_feature_control',
      'powerhub_get_active_addon_delta',
      'powerhub_prepare_addon_renewal_choices'
    )
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, anon, authenticated',v_function);
  END LOOP;
END
$widen_function_acl$;

-- Simulate RLS policy drift: preserve the canonical names but widen both their
-- predicates and the same-named guards. Leave one additional permissive policy
-- in place to prove the restrictive guard still caps its effective scope.
DO $widen_policy_scope$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT * FROM (VALUES
      ('access_recovery_requests','access_recovery_tenant_isolation','access_recovery_scope_guard'),
      ('complaints','complaints_tenant_isolation','complaints_scope_guard'),
      ('meters','meters_tenant_isolation','meters_scope_guard'),
      ('platform_tariff_policies','platform_tariff_policies_platform_admin_only','platform_tariff_policies_admin_guard'),
      ('user_quick_action_preferences','quick_actions_owner_only','quick_actions_owner_guard')
    ) AS policies(table_name, permissive_policy, restrictive_policy)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',v_policy.permissive_policy,v_policy.table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true)',v_policy.permissive_policy,v_policy.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',v_policy.restrictive_policy,v_policy.table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true)',v_policy.restrictive_policy,v_policy.table_name);
  END LOOP;

  DROP POLICY IF EXISTS staging_reconciliation_open_policy ON public.complaints;
  CREATE POLICY staging_reconciliation_open_policy ON public.complaints
    AS PERMISSIVE FOR ALL TO authenticated USING (true) WITH CHECK (true);
END
$widen_policy_scope$;

\ir ../migrations/20261025101753_powerhub_missing_schema_and_rpc_reconciliation.sql
\ir ../migrations/20261025182440_powerhub_scoped_platform_admin_and_recovery_rpc.sql
-- Simulate the untracked legacy production function: its OUT columns differ even
-- though its input signature is identical. The forward migration must replace it.
CREATE OR REPLACE FUNCTION public.powerhub_admin_begin_generator_owner_provisioning(
  p_actor_user_id bigint,
  p_client_operation_id uuid,
  p_owner_email text,
  p_request_fingerprint text
)
RETURNS TABLE(client_operation_id uuid, auth_user_id uuid, status text, replayed boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $legacy$
  SELECT p_client_operation_id, NULL::uuid, 'pending'::text, false;
$legacy$;
ALTER FUNCTION public.powerhub_admin_begin_generator_owner_provisioning(bigint, uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.powerhub_admin_begin_generator_owner_provisioning(bigint, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_admin_begin_generator_owner_provisioning(bigint, uuid, text, text) TO service_role;

\ir ../migrations/20261025182544_powerhub_owner_provisioning_lifecycle_reconciliation.sql
-- Both forward migrations must be safe to replay without duplicating policy/function state.
\ir ../migrations/20261025182440_powerhub_scoped_platform_admin_and_recovery_rpc.sql
\ir ../migrations/20261025182544_powerhub_owner_provisioning_lifecycle_reconciliation.sql

DO $assert_reconciliation$
DECLARE
  v_table text;
  v_signature text;
  v_role text;
  v_privilege text;
  v_policy record;
  v_policy_mode text;
  v_policy_qual text;
  v_policy_check text;
  v_authenticated_read_tables text[] := ARRAY[
    'access_recovery_requests','complaints','meters','platform_tariff_policies','user_quick_action_preferences'
  ];
  v_internal_tables text[] := ARRAY[
    'feature_global_control_audit','generator_owner_provisioning_operations',
    'password_reset_intents','subscription_renewal_operations',
    'tenant_addon_renewal_decisions','tenant_owner_alerts'
  ];
  v_server_functions text[] := ARRAY[
    'public.powerhub_admin_begin_generator_owner_provisioning(bigint,uuid,text,text)',
    'public.powerhub_admin_attach_generator_owner_provisioning_auth(bigint,uuid,uuid,text)',
    'public.powerhub_admin_cancel_generator_owner_provisioning(bigint,uuid,text,uuid)',
    'public.powerhub_admin_get_generator_owner_provisioning_reconciliation(bigint,uuid,text)',
    'public.powerhub_admin_complete_generator_owner_provisioning(bigint,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,integer,text,text,text,timestamptz,integer)',
    'public.powerhub_admin_create_tariff_policy(bigint,numeric,numeric,timestamptz,boolean,text)',
    'public.powerhub_admin_grant_tenant_addon(bigint,bigint,text,integer,text,text,uuid)',
    'public.powerhub_admin_renew_subscription_idempotent(bigint,bigint,integer,text)',
    'public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,text,jsonb,uuid)',
    'public.powerhub_admin_request_owner_access_recovery(bigint,bigint,text,text,text)',
    'public.powerhub_admin_review_tenant_addon_request(bigint,bigint,text,text,integer)',
    'public.powerhub_admin_set_feature_global(bigint,text,boolean)',
    'public.powerhub_admin_set_tenant_feature_control(bigint,bigint,text,text,text,integer,text)',
    'public.powerhub_get_active_addon_delta(bigint,text,timestamptz)',
    'public.powerhub_prepare_addon_renewal_choices(bigint)'
  ];
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'access_recovery_requests','complaints','feature_global_control_audit',
    'generator_owner_provisioning_operations','meters','password_reset_intents',
    'platform_tariff_policies','subscription_renewal_operations',
    'tenant_addon_renewal_decisions','tenant_owner_alerts','user_quick_action_preferences'
  ] LOOP
    IF to_regclass('public.'||v_table) IS NULL THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_TABLE_MISSING: %',v_table;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.'||v_table)) THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_RLS_NOT_ENABLED: %',v_table;
    END IF;
    -- Anonymous users must not have direct table access; authenticated read
    -- grants are limited to the five RLS-scoped tables used by app queries.
    IF has_table_privilege('anon','public.'||v_table,'SELECT') THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_ANON_READ_REMAINS: %',v_table;
    END IF;
    IF v_table = ANY(v_authenticated_read_tables) THEN
      IF NOT has_table_privilege('authenticated','public.'||v_table,'SELECT') THEN
        RAISE EXCEPTION 'SCHEMA_RECONCILIATION_AUTHENTICATED_READ_MISSING: %',v_table;
      END IF;
    ELSIF has_table_privilege('authenticated','public.'||v_table,'SELECT') THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_INTERNAL_TABLE_EXPOSED: %',v_table;
    END IF;

    -- RLS does not protect object-management privileges. Browser roles must
    -- not be able to add triggers, create foreign keys, or maintain these tables.
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      FOREACH v_privilege IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
        IF has_table_privilege(v_role,'public.'||v_table,v_privilege) THEN
          RAISE EXCEPTION 'SCHEMA_RECONCILIATION_BROWSER_PRIVILEGE_REMAINS: table %, role %, privilege %',v_table,v_role,v_privilege;
        END IF;
      END LOOP;
    END LOOP;
    IF NOT has_table_privilege('service_role','public.'||v_table,'SELECT')
       OR NOT has_table_privilege('service_role','public.'||v_table,'INSERT')
       OR NOT has_table_privilege('service_role','public.'||v_table,'UPDATE')
       OR NOT has_table_privilege('service_role','public.'||v_table,'DELETE') THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_SERVICE_GRANTS_MISSING: %',v_table;
    END IF;
  END LOOP;

  IF to_regprocedure('private.powerhub_current_user_id()') IS NULL
     OR to_regprocedure('private.powerhub_has_tenant_access(bigint)') IS NULL
     OR to_regprocedure('private.powerhub_is_platform_admin()') IS NULL
     OR to_regprocedure('private.powerhub_is_platform_management_admin()') IS NULL THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_PRIVATE_RLS_HELPERS_MISSING';
  END IF;
  IF NOT has_function_privilege('authenticated','private.powerhub_current_user_id()','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_has_tenant_access(bigint)','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_is_platform_admin()','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_is_platform_management_admin()','EXECUTE') THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_PRIVATE_RLS_HELPER_GRANTS_MISSING';
  END IF;
  IF has_function_privilege('anon','private.powerhub_current_user_id()','EXECUTE')
     OR has_function_privilege('anon','private.powerhub_has_tenant_access(bigint)','EXECUTE')
     OR has_function_privilege('anon','private.powerhub_is_platform_admin()','EXECUTE')
     OR has_function_privilege('anon','private.powerhub_is_platform_management_admin()','EXECUTE') THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_PRIVATE_RLS_HELPER_EXPOSED_TO_ANON';
  END IF;

  -- Five canonical permissive policies, five restrictive scope guards, plus the
  -- deliberate stray permissive-policy fixture that must remain contained.
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public' AND tablename IN (
        'access_recovery_requests','complaints','feature_global_control_audit',
        'generator_owner_provisioning_operations','meters','password_reset_intents',
        'platform_tariff_policies','subscription_renewal_operations',
        'tenant_addon_renewal_decisions','tenant_owner_alerts','user_quick_action_preferences'
      )) <> 11 THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_POLICY_COUNT_MISMATCH';
  END IF;

  FOR v_policy IN
    SELECT * FROM (VALUES
      ('access_recovery_requests','access_recovery_tenant_isolation','access_recovery_scope_guard','powerhub_is_platform_management_admin','powerhub_is_platform_management_admin'),
      ('complaints','complaints_tenant_isolation','complaints_scope_guard','powerhub_has_tenant_access','powerhub_is_platform_admin'),
      ('meters','meters_tenant_isolation','meters_scope_guard','powerhub_has_tenant_access','powerhub_is_platform_admin'),
      ('platform_tariff_policies','platform_tariff_policies_platform_admin_only','platform_tariff_policies_admin_guard','powerhub_is_platform_management_admin',NULL),
      ('user_quick_action_preferences','quick_actions_owner_only','quick_actions_owner_guard','powerhub_current_user_id','powerhub_is_platform_management_admin')
    ) AS expected(table_name, permissive_policy, restrictive_policy, helper_one, helper_two)
  LOOP
    SELECT permissive, qual, with_check
      INTO v_policy_mode, v_policy_qual, v_policy_check
    FROM pg_policies
    WHERE schemaname='public' AND tablename=v_policy.table_name AND policyname=v_policy.permissive_policy;
    IF NOT FOUND OR v_policy_mode <> 'PERMISSIVE'
       OR position(v_policy.helper_one in coalesce(v_policy_qual,'')) = 0
       OR position(v_policy.helper_one in coalesce(v_policy_check,'')) = 0
       OR (v_policy.helper_two IS NOT NULL AND (
         position(v_policy.helper_two in coalesce(v_policy_qual,'')) = 0
         OR position(v_policy.helper_two in coalesce(v_policy_check,'')) = 0
       )) THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_CANONICAL_POLICY_DRIFT: %',v_policy.permissive_policy;
    END IF;

    SELECT permissive, qual, with_check
      INTO v_policy_mode, v_policy_qual, v_policy_check
    FROM pg_policies
    WHERE schemaname='public' AND tablename=v_policy.table_name AND policyname=v_policy.restrictive_policy;
    IF NOT FOUND OR v_policy_mode <> 'RESTRICTIVE'
       OR position(v_policy.helper_one in coalesce(v_policy_qual,'')) = 0
       OR position(v_policy.helper_one in coalesce(v_policy_check,'')) = 0
       OR (v_policy.helper_two IS NOT NULL AND (
         position(v_policy.helper_two in coalesce(v_policy_qual,'')) = 0
         OR position(v_policy.helper_two in coalesce(v_policy_check,'')) = 0
       )) THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_RESTRICTIVE_GUARD_MISSING_OR_DRIFTED: %',v_policy.restrictive_policy;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='complaints'
      AND policyname='staging_reconciliation_open_policy' AND permissive='PERMISSIVE'
  ) THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_STRAY_PERMISSIVE_POLICY_FIXTURE_MISSING';
  END IF;

  IF (SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname='public' AND c.relname IN ('complaints','meters','user_quick_action_preferences')
        AND t.tgname IN ('complaints_set_updated_at','meters_set_updated_at','quick_actions_set_updated_at')) <> 3 THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_TRIGGERS_MISSING_OR_DUPLICATED';
  END IF;

  FOREACH v_signature IN ARRAY v_server_functions LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_RPC_SIGNATURE_MISSING: %',v_signature;
    END IF;
    IF has_function_privilege('anon',to_regprocedure(v_signature),'EXECUTE')
       OR has_function_privilege('authenticated',to_regprocedure(v_signature),'EXECUTE') THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_RPC_BROWSER_EXECUTE_REMAINS: %',v_signature;
    END IF;
    IF NOT has_function_privilege('service_role',to_regprocedure(v_signature),'EXECUTE') THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_RPC_SERVICE_GRANT_MISSING: %',v_signature;
    END IF;
  END LOOP;

  -- Assert the new RPC result contract, not only its input signature.
  IF position('can_create_auth boolean' IN pg_get_function_result(
       to_regprocedure('public.powerhub_admin_begin_generator_owner_provisioning(bigint,uuid,text,text)')
     )) = 0
     OR position('needs_reconciliation boolean' IN pg_get_function_result(
       to_regprocedure('public.powerhub_admin_begin_generator_owner_provisioning(bigint,uuid,text,text)')
     )) = 0
     OR position('client_operation_id uuid' IN pg_get_function_result(
       to_regprocedure('public.powerhub_admin_begin_generator_owner_provisioning(bigint,uuid,text,text)')
     )) > 0 THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_OWNER_PROVISIONING_RETURN_CONTRACT_DRIFT';
  END IF;

  IF to_regprocedure('public.powerhub_admin_request_owner_access_recovery(bigint,bigint,text)') IS NOT NULL
     OR to_regprocedure('public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb)') IS NOT NULL
     OR to_regprocedure('public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_STALE_RPC_OVERLOAD_REMAINS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='offline_sync_operations'
      AND column_name='request_fingerprint' AND data_type='text' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_REQUEST_FINGERPRINT_COLUMN_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='notification_messages'
      AND column_name='scheduled_at' AND is_nullable='NO'
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_SCHEDULED_AT_DEFAULT_OR_NOT_NULL_MISSING';
  END IF;

  IF (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename IN (
        'access_recovery_requests','complaints','feature_global_control_audit',
        'generator_owner_provisioning_operations','meters','password_reset_intents',
        'platform_tariff_policies','subscription_renewal_operations',
        'tenant_addon_renewal_decisions','tenant_owner_alerts','user_quick_action_preferences'
      )) < 25 THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_INDEX_SET_INCOMPLETE';
  END IF;
END
$assert_reconciliation$;

-- Exercise the owner-provisioning idempotency state machine in the disposable DB:
-- reserve, bind Auth, replay without creating another Auth user, reject fingerprint reuse,
-- and cancel only the matching pending operation.
INSERT INTO public.users (id, role, platform_role, account_status, email)
VALUES (92001, 'admin', 'platform_admin', 'active', 'provisioning-admin@example.test');

DO $assert_owner_provisioning_lifecycle$
DECLARE
  v_first record;
  v_replay record;
  v_conflict boolean := false;
  v_operation_id uuid := '92001000-0000-4000-8000-000000000001';
  v_auth_id uuid := '92001000-0000-4000-8000-000000000002';
  v_fingerprint text := repeat('a', 64);
BEGIN
  SELECT * INTO v_first
  FROM public.powerhub_admin_begin_generator_owner_provisioning(
    92001, v_operation_id, 'owner-lifecycle@example.test', v_fingerprint
  );
  IF v_first.operation_status <> 'pending'
     OR NOT v_first.can_create_auth
     OR v_first.needs_reconciliation
     OR v_first.success THEN
    RAISE EXCEPTION 'OWNER_PROVISIONING_INITIAL_RESERVATION_INVALID: %', row_to_json(v_first);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.powerhub_admin_get_generator_owner_provisioning_reconciliation(
      92001, v_operation_id, v_fingerprint
    ) AS r
    WHERE r.operation_status = 'pending'
      AND r.owner_email = 'owner-lifecycle@example.test'
      AND r.auth_user_id IS NULL
      AND r.request_fingerprint = v_fingerprint
      AND r.auth_creation_started_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'OWNER_PROVISIONING_RECONCILIATION_ENVELOPE_INVALID';
  END IF;

  PERFORM * FROM public.powerhub_admin_attach_generator_owner_provisioning_auth(
    92001, v_operation_id, v_auth_id, v_fingerprint
  );

  SELECT * INTO v_replay
  FROM public.powerhub_admin_begin_generator_owner_provisioning(
    92001, v_operation_id, 'owner-lifecycle@example.test', v_fingerprint
  );
  IF v_replay.auth_user_id IS DISTINCT FROM v_auth_id
     OR v_replay.can_create_auth
     OR v_replay.needs_reconciliation
     OR v_replay.success THEN
    RAISE EXCEPTION 'OWNER_PROVISIONING_AUTH_REPLAY_INVALID: %', row_to_json(v_replay);
  END IF;

  BEGIN
    PERFORM * FROM public.powerhub_admin_begin_generator_owner_provisioning(
      92001, v_operation_id, 'owner-lifecycle@example.test', repeat('b', 64)
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_conflict := true;
  END;
  IF NOT v_conflict THEN
    RAISE EXCEPTION 'OWNER_PROVISIONING_FINGERPRINT_CONFLICT_NOT_REJECTED';
  END IF;

  PERFORM * FROM public.powerhub_admin_cancel_generator_owner_provisioning(
    92001, v_operation_id, v_fingerprint, v_auth_id
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.generator_owner_provisioning_operations
    WHERE client_operation_id = v_operation_id AND status = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'OWNER_PROVISIONING_CANCEL_TOMBSTONE_MISSING';
  END IF;

  SELECT * INTO v_replay
  FROM public.powerhub_admin_begin_generator_owner_provisioning(
    92001, v_operation_id, 'owner-lifecycle@example.test', v_fingerprint
  );
  IF v_replay.can_create_auth OR NOT v_replay.needs_reconciliation OR v_replay.success THEN
    RAISE EXCEPTION 'OWNER_PROVISIONING_CANCELLED_OPERATION_REOPENED: %', row_to_json(v_replay);
  END IF;

  v_conflict := false;
  BEGIN
    UPDATE public.generator_owner_provisioning_operations
    SET status = 'completed'
    WHERE client_operation_id = v_operation_id;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_conflict := true;
  END;
  IF NOT v_conflict OR NOT EXISTS (
    SELECT 1 FROM public.generator_owner_provisioning_operations
    WHERE client_operation_id = v_operation_id AND status = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'OWNER_PROVISIONING_CANCELLED_TOMBSTONE_WAS_MUTABLE';
  END IF;
END
$assert_owner_provisioning_lifecycle$;

-- Exercise effective RLS, not only catalog metadata. A deliberate permissive TRUE
-- policy remains on complaints; the restrictive guard must still hide another tenant.
GRANT USAGE ON SCHEMA private TO authenticated;
CREATE OR REPLACE FUNCTION private.powerhub_has_tenant_access(target_tenant_id bigint)
RETURNS boolean LANGUAGE sql STABLE AS $function$
  SELECT target_tenant_id = NULLIF(current_setting('powerhub.test_tenant_id', true), '')::bigint
$function$;

INSERT INTO public.tenants(id,name,slug,status) VALUES
  (91001,'RLS fixture tenant A','rls-fixture-tenant-a','active'),
  (91002,'RLS fixture tenant B','rls-fixture-tenant-b','active');
INSERT INTO public.sites(id,tenant_id,name,code,status,city) VALUES
  (91001,91001,'RLS fixture site A','RLS-A','active','fixture'),
  (91002,91002,'RLS fixture site B','RLS-B','active','fixture');
INSERT INTO public.complaints(tenant_id,site_id,title,description) VALUES
  (91001,91001,'staging-rls-scope-tenant-a','RLS fixture A'),
  (91002,91002,'staging-rls-scope-tenant-b','RLS fixture B');

SELECT set_config('powerhub.test_tenant_id','91001',false);
SET ROLE authenticated;
DO $assert_effective_tenant_scope$
DECLARE v_visible integer;
BEGIN
  SELECT count(*) INTO v_visible
  FROM public.complaints
  WHERE title IN ('staging-rls-scope-tenant-a','staging-rls-scope-tenant-b');
  IF v_visible <> 1 THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_RESTRICTIVE_RLS_BYPASS: expected only tenant A row, observed %',v_visible;
  END IF;
END
$assert_effective_tenant_scope$;
RESET ROLE;
SELECT set_config('powerhub.test_tenant_id','',false);

SELECT 'staging schema reconciliation passed twice: 11 tables, ACL/RLS guards, 10 canonical policies plus one contained stray policy, 3 triggers, 11 server-only RPCs, stale overloads removed' AS result;
