\set ON_ERROR_STOP on

DO $roles$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $roles$;
DO $roles$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $roles$;
DO $roles$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $roles$;

CREATE OR REPLACE FUNCTION public.powerhub_set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $function$
BEGIN
  NEW.updated_at:=now();
  RETURN NEW;
END
$function$;

CREATE TABLE public.collector_sessions (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.custom_permission_roles (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.employees (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.financial_settlements (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.platform_sms_fallback_providers (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.platform_sms_plans (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.platform_tweetsms_accounts (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.platform_tweetsms_balance_alerts (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.staff_profiles (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.subscribers (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.tenant_branch_settings (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.tenant_owner_profiles (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.tenant_subscriptions (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.tenant_tweetsms_accounts (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.tenants (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);
CREATE TABLE public.users (id bigint PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT '2000-01-01'::timestamptz);

CREATE TABLE public.tenant_addon_requests (
  id bigint PRIMARY KEY, tenant_id bigint, addon_code text, status text,
  starts_at timestamptz, ends_at timestamptz, duration_days integer
);
CREATE TABLE public.tenant_feature_controls (id bigint PRIMARY KEY, tenant_id bigint, feature_key text);
CREATE TABLE public.feature_catalog (feature_key text PRIMARY KEY, feature_type text);
ALTER TABLE public.financial_settlements
  ADD COLUMN tenant_id bigint, ADD COLUMN site_id bigint, ADD COLUMN status text,
  ADD COLUMN period_start date, ADD COLUMN period_end date;
ALTER TABLE public.tenant_subscriptions
  ADD COLUMN tenant_id bigint, ADD COLUMN status text, ADD COLUMN started_at timestamptz,
  ADD COLUMN ends_at timestamptz, ADD COLUMN trial_duration_days integer, ADD COLUMN auto_renew boolean;


\ir ../migrations/20261030230000_powerhub_missing_production_triggers_reconcile.sql
\ir ../migrations/20261030230000_powerhub_missing_production_triggers_reconcile.sql

DO $assert_triggers$
DECLARE
  v record;
  v_count integer;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('collector_sessions','collector_sessions_set_updated_at'),
      ('custom_permission_roles','custom_permission_roles_set_updated_at'),
      ('employees','employees_set_updated_at'),
      ('financial_settlements','financial_settlements_set_updated_at'),
      ('platform_sms_fallback_providers','platform_sms_fallback_set_updated_at'),
      ('platform_sms_plans','platform_sms_plans_set_updated_at'),
      ('platform_tweetsms_accounts','platform_tweetsms_set_updated_at'),
      ('platform_tweetsms_balance_alerts','platform_tweetsms_alert_set_updated_at'),
      ('staff_profiles','staff_profiles_set_updated_at'),
      ('subscribers','subscribers_set_updated_at'),
      ('tenant_branch_settings','tenant_branch_settings_set_updated_at'),
      ('tenant_owner_profiles','tenant_owner_profiles_set_updated_at'),
      ('tenant_subscriptions','tenant_subscriptions_set_updated_at'),
      ('tenant_tweetsms_accounts','tenant_tweetsms_set_updated_at'),
      ('tenants','tenants_set_updated_at'),
      ('users','users_set_updated_at'),
      ('financial_settlements','trg_powerhub_guard_locked_financial_settlement'),
      ('tenant_addon_requests','trg_powerhub_sync_sms_addon_end'),
      ('tenant_feature_controls','trg_powerhub_tenant_feature_control_scope'),
      ('tenant_subscriptions','trg_powerhub_trial_duration')
  ) AS expected(table_name,trigger_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v.table_name AND t.tgname=v.trigger_name
        AND NOT t.tgisinternal AND t.tgenabled='O'
    ) THEN RAISE EXCEPTION 'PRODUCTION_TRIGGER_MISSING_OR_DISABLED: %.%',v.table_name,v.trigger_name; END IF;
  END LOOP;
  SELECT count(*) INTO v_count FROM pg_trigger t
  JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT t.tgisinternal AND (
    (c.relname,t.tgname) IN (VALUES ('collector_sessions','collector_sessions_set_updated_at'),
      ('custom_permission_roles','custom_permission_roles_set_updated_at'),
      ('employees','employees_set_updated_at'),
      ('financial_settlements','financial_settlements_set_updated_at'),
      ('platform_sms_fallback_providers','platform_sms_fallback_set_updated_at'),
      ('platform_sms_plans','platform_sms_plans_set_updated_at'),
      ('platform_tweetsms_accounts','platform_tweetsms_set_updated_at'),
      ('platform_tweetsms_balance_alerts','platform_tweetsms_alert_set_updated_at'),
      ('staff_profiles','staff_profiles_set_updated_at'),
      ('subscribers','subscribers_set_updated_at'),
      ('tenant_branch_settings','tenant_branch_settings_set_updated_at'),
      ('tenant_owner_profiles','tenant_owner_profiles_set_updated_at'),
      ('tenant_subscriptions','tenant_subscriptions_set_updated_at'),
      ('tenant_tweetsms_accounts','tenant_tweetsms_set_updated_at'),
      ('tenants','tenants_set_updated_at'),
      ('users','users_set_updated_at'),
      ('financial_settlements','trg_powerhub_guard_locked_financial_settlement'),
      ('tenant_addon_requests','trg_powerhub_sync_sms_addon_end'),
      ('tenant_feature_controls','trg_powerhub_tenant_feature_control_scope'),
      ('tenant_subscriptions','trg_powerhub_trial_duration'))
  );
  IF v_count <> 20 THEN RAISE EXCEPTION 'PRODUCTION_TRIGGER_COUNT_MISMATCH: %',v_count; END IF;
END
$assert_triggers$;

INSERT INTO public.users(id) VALUES (1);
UPDATE public.users SET id=1 WHERE id=1;
DO $assert_updated_at$
BEGIN
  IF (SELECT updated_at <= '2000-01-01'::timestamptz FROM public.users WHERE id=1) THEN
    RAISE EXCEPTION 'UPDATED_AT_TRIGGER_DID_NOT_ADVANCE';
  END IF;
END
$assert_updated_at$;

INSERT INTO public.financial_settlements(id,tenant_id,site_id,status,period_start,period_end)
VALUES (1,10,20,'locked','2026-01-01','2026-02-01');
DO $assert_locked_settlement$
BEGIN
  BEGIN
    UPDATE public.financial_settlements SET status='open' WHERE id=1;
    RAISE EXCEPTION 'LOCKED_SETTLEMENT_MUTATION_WAS_ALLOWED';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'LOCKED_SETTLEMENT_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.financial_settlements(id,tenant_id,site_id,status,period_start,period_end)
    VALUES (2,10,20,'locked','2026-01-15','2026-02-15');
    RAISE EXCEPTION 'OVERLAPPING_LOCKED_SETTLEMENT_WAS_ALLOWED';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'SETTLEMENT_PERIOD_OVERLAP' THEN RAISE; END IF;
  END;
END
$assert_locked_settlement$;

INSERT INTO public.feature_catalog(feature_key,feature_type) VALUES ('subscriber_limit','quota'),('bad_flag','boolean');
INSERT INTO public.tenant_feature_controls(id,tenant_id,feature_key) VALUES (1,10,'subscriber_limit');
DO $assert_feature_scope$
BEGIN
  BEGIN
    INSERT INTO public.tenant_feature_controls(id,tenant_id,feature_key) VALUES (2,10,'bad_flag');
    RAISE EXCEPTION 'NON_CONTROLLABLE_FEATURE_WAS_ALLOWED';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'FEATURE_NOT_TENANT_CONTROLLABLE' THEN RAISE; END IF;
  END;
END
$assert_feature_scope$;

INSERT INTO public.tenant_subscriptions(id,tenant_id,status,started_at,trial_duration_days,auto_renew)
VALUES (1,10,'trial','2026-10-01 00:00:00+00',8,true);
DO $assert_trial_duration$
BEGIN
  IF (SELECT ends_at <> '2026-10-09 00:00:00+00'::timestamptz OR auto_renew FROM public.tenant_subscriptions WHERE id=1) THEN
    RAISE EXCEPTION 'TRIAL_DURATION_TRIGGER_MISMATCH';
  END IF;
END
$assert_trial_duration$;

INSERT INTO public.tenant_subscriptions(id,tenant_id,status,started_at,ends_at,trial_duration_days,auto_renew)
VALUES (2,20,'active','2026-01-01','2026-12-31',NULL,true);
INSERT INTO public.tenant_addon_requests(id,tenant_id,addon_code,status,starts_at,ends_at,duration_days)
VALUES (1,20,'sms','approved','2026-11-01','2026-11-15',14);
DO $assert_sms_addon_end$
BEGIN
  IF (SELECT ends_at <> '2026-12-31'::timestamptz FROM public.tenant_addon_requests WHERE id=1) THEN
    RAISE EXCEPTION 'SMS_ADDON_END_NOT_ALIGNED_TO_SUBSCRIPTION';
  END IF;
END
$assert_sms_addon_end$;

SELECT 'missing production triggers restored and behavior verified: 20 triggers' AS result;
