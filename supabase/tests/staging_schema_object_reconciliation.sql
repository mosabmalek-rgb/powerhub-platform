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

CREATE SCHEMA private;
CREATE OR REPLACE FUNCTION private.powerhub_has_tenant_access(bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION private.powerhub_is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION private.powerhub_current_user_id()
RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT NULL::bigint $$;

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
CREATE TABLE public.feature_catalog (
  feature_key text PRIMARY KEY, is_active boolean, updated_at timestamptz
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
\ir ../migrations/20261025020000_powerhub_missing_schema_and_rpc_reconciliation.sql

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

\ir ../migrations/20261025020000_powerhub_missing_schema_and_rpc_reconciliation.sql

DO $assert_reconciliation$
DECLARE
  v_table text;
  v_signature text;
  v_internal_tables text[] := ARRAY[
    'feature_global_control_audit','generator_owner_provisioning_operations',
    'password_reset_intents','subscription_renewal_operations',
    'tenant_addon_renewal_decisions','tenant_owner_alerts'
  ];
  v_server_functions text[] := ARRAY[
    'public.powerhub_admin_complete_generator_owner_provisioning(bigint,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,integer)',
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
    IF has_table_privilege('anon','public.'||v_table,'INSERT')
       OR has_table_privilege('authenticated','public.'||v_table,'INSERT')
       OR has_table_privilege('anon','public.'||v_table,'UPDATE')
       OR has_table_privilege('authenticated','public.'||v_table,'UPDATE')
       OR has_table_privilege('anon','public.'||v_table,'DELETE')
       OR has_table_privilege('authenticated','public.'||v_table,'DELETE') THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_BROWSER_DML_REMAINS: %',v_table;
    END IF;
    IF NOT has_table_privilege('service_role','public.'||v_table,'SELECT')
       OR NOT has_table_privilege('service_role','public.'||v_table,'INSERT')
       OR NOT has_table_privilege('service_role','public.'||v_table,'UPDATE')
       OR NOT has_table_privilege('service_role','public.'||v_table,'DELETE') THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_SERVICE_GRANTS_MISSING: %',v_table;
    END IF;
  END LOOP;

  FOREACH v_table IN ARRAY v_internal_tables LOOP
    IF has_table_privilege('anon','public.'||v_table,'SELECT')
       OR has_table_privilege('authenticated','public.'||v_table,'SELECT') THEN
      RAISE EXCEPTION 'SCHEMA_RECONCILIATION_INTERNAL_TABLE_EXPOSED: %',v_table;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname='public' AND tablename IN (
        'access_recovery_requests','complaints','feature_global_control_audit',
        'generator_owner_provisioning_operations','meters','password_reset_intents',
        'platform_tariff_policies','subscription_renewal_operations',
        'tenant_addon_renewal_decisions','tenant_owner_alerts','user_quick_action_preferences'
      )) <> 5 THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_POLICY_COUNT_MISMATCH';
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

  IF to_regprocedure('public.powerhub_admin_request_owner_access_recovery(bigint,bigint,text)') IS NOT NULL
     OR to_regprocedure('public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb)') IS NOT NULL
     OR to_regprocedure('public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'SCHEMA_RECONCILIATION_STALE_RPC_OVERLOAD_REMAINS';
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

SELECT 'staging schema reconciliation passed twice: 11 tables, RLS/grants, 5 policies, 3 triggers, 11 server-only RPCs, stale overloads removed' AS result;
