\set ON_ERROR_STOP on

DO $roles$
BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END
$roles$;
DO $roles$
BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END
$roles$;
DO $roles$
BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END
$roles$;

CREATE TABLE public.access_invitations (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.collector_sessions (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.company_account_sites (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.custom_permission_roles (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.emergency_requests (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.employee_adjustments (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.employee_attendance (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.employees (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.financial_settlements (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.invoice_lines (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.mobile_api_sessions (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.mobile_sync_events (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.payroll_items (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.payroll_runs (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.platform_access_invitations (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.platform_role_policies (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.platform_sms_plans (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.site_portal_settings (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.sms_dispatch_queue (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.sms_package_requests (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.staff_profiles (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.subscription_upgrade_requests (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.tariffs (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.tenant_branch_settings (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.tenant_messaging_configurations (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.tenant_owner_profiles (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.tenant_subscriptions (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.tenants (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.tweet_sms_report_snapshots (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);
CREATE TABLE public.users (id bigint PRIMARY KEY, tenant_id bigint, user_id bigint);

ALTER TABLE public.access_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.access_invitations FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.collector_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.collector_sessions FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.company_account_sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.company_account_sites FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.custom_permission_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.custom_permission_roles FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.emergency_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.emergency_requests FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.employee_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.employee_adjustments FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.employee_attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.employee_attendance FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.employees FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.financial_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.financial_settlements FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.invoice_lines FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.mobile_api_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.mobile_api_sessions FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.mobile_sync_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.mobile_sync_events FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.payroll_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.payroll_items FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.payroll_runs FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.platform_access_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.platform_access_invitations FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.platform_role_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.platform_role_policies FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.platform_sms_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.platform_sms_plans FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.site_portal_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.site_portal_settings FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.sms_dispatch_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.sms_dispatch_queue FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.sms_package_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.sms_package_requests FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.staff_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.staff_profiles FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.subscription_upgrade_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.subscription_upgrade_requests FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.tariffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.tariffs FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.tenant_branch_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.tenant_branch_settings FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.tenant_messaging_configurations ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.tenant_messaging_configurations FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.tenant_owner_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.tenant_owner_profiles FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.tenant_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.tenant_subscriptions FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.tenants FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.tweet_sms_report_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.tweet_sms_report_snapshots FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_tenant_access ON public.users FOR ALL TO PUBLIC USING (true) WITH CHECK (true);

-- Reproduce the broad staging ACL found by the live environment comparison.
GRANT ALL PRIVILEGES ON TABLE
  public.access_invitations,
  public.collector_sessions,
  public.company_account_sites,
  public.custom_permission_roles,
  public.emergency_requests,
  public.employee_adjustments,
  public.employee_attendance,
  public.employees,
  public.financial_settlements,
  public.invoice_lines,
  public.mobile_api_sessions,
  public.mobile_sync_events,
  public.payroll_items,
  public.payroll_runs,
  public.platform_access_invitations,
  public.platform_role_policies,
  public.platform_sms_plans,
  public.site_portal_settings,
  public.sms_dispatch_queue,
  public.sms_package_requests,
  public.staff_profiles,
  public.subscription_upgrade_requests,
  public.tariffs,
  public.tenant_branch_settings,
  public.tenant_messaging_configurations,
  public.tenant_owner_profiles,
  public.tenant_subscriptions,
  public.tenants,
  public.tweet_sms_report_snapshots,
  public.users
TO PUBLIC, anon, authenticated, service_role;

\ir ../migrations/20261030200000_powerhub_browser_direct_dml_acl_reconcile.sql

-- Re-run the forward-only reconciliation to assert idempotency.
\ir ../migrations/20261030200000_powerhub_browser_direct_dml_acl_reconcile.sql

DO $assert_acl$
DECLARE
  v_table text;
  v_privilege text;
  v_tables constant text[] := ARRAY[
    'access_invitations',
    'collector_sessions',
    'company_account_sites',
    'custom_permission_roles',
    'emergency_requests',
    'employee_adjustments',
    'employee_attendance',
    'employees',
    'financial_settlements',
    'invoice_lines',
    'mobile_api_sessions',
    'mobile_sync_events',
    'payroll_items',
    'payroll_runs',
    'platform_access_invitations',
    'platform_role_policies',
    'platform_sms_plans',
    'site_portal_settings',
    'sms_dispatch_queue',
    'sms_package_requests',
    'staff_profiles',
    'subscription_upgrade_requests',
    'tariffs',
    'tenant_branch_settings',
    'tenant_messaging_configurations',
    'tenant_owner_profiles',
    'tenant_subscriptions',
    'tenants',
    'tweet_sms_report_snapshots',
    'users'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relname=v_table) THEN
      RAISE EXCEPTION 'RLS_DISABLED_ON_%',v_table;
    END IF;
    IF NOT has_table_privilege('anon',format('public.%I',v_table),'SELECT') THEN
      RAISE EXCEPTION 'ANON_SELECT_REMOVED_ON_%',v_table;
    END IF;
    IF NOT has_table_privilege('authenticated',format('public.%I',v_table),'SELECT') THEN
      RAISE EXCEPTION 'AUTHENTICATED_SELECT_REMOVED_ON_%',v_table;
    END IF;
    IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=v_table AND p.polname='test_tenant_access') <> 1 THEN
      RAISE EXCEPTION 'RLS_POLICY_CHANGED_ON_%',v_table;
    END IF;
    FOREACH v_privilege IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
      IF has_table_privilege('anon',format('public.%I',v_table),v_privilege) THEN
        RAISE EXCEPTION 'ANON_DIRECT_%_REMAINS_ON_%',v_privilege,v_table;
      END IF;
      IF has_table_privilege('authenticated',format('public.%I',v_table),v_privilege) THEN
        RAISE EXCEPTION 'AUTHENTICATED_DIRECT_%_REMAINS_ON_%',v_privilege,v_table;
      END IF;
      IF has_table_privilege('service_role',format('public.%I',v_table),v_privilege) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'SERVICE_ROLE_%_REMOVED_ON_%',v_privilege,v_table;
      END IF;
    END LOOP;
  END LOOP;
END
$assert_acl$;

-- These three Staging-only tables are absent from Production. The conditional
-- migration must skip them cleanly when the same forward migration is replayed.
DROP TABLE public.emergency_requests;
DROP TABLE public.sms_dispatch_queue;
DROP TABLE public.tweet_sms_report_snapshots;

\ir ../migrations/20261030200000_powerhub_browser_direct_dml_acl_reconcile.sql

DO $assert_optional_tables$
BEGIN
  IF to_regclass('public.emergency_requests') IS NOT NULL
     OR to_regclass('public.sms_dispatch_queue') IS NOT NULL
     OR to_regclass('public.tweet_sms_report_snapshots') IS NOT NULL THEN
    RAISE EXCEPTION 'OPTIONAL_STAGING_TABLE_WAS_RECREATED';
  END IF;
END
$assert_optional_tables$;

SELECT 'browser direct DML ACL reconciliation passed for 30 tenant-scoped tables and 3 absent production tables' AS result;
