\set ON_ERROR_STOP on

DO $roles$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $roles$;
DO $roles$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $roles$;
DO $roles$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $roles$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $function$ SELECT NULL::uuid $function$;
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.powerhub_has_tenant_access(target_tenant_id bigint) RETURNS boolean LANGUAGE sql STABLE AS $function$
  SELECT target_tenant_id = nullif(current_setting('test.tenant_id', true), '')::bigint
$function$;
CREATE OR REPLACE FUNCTION private.powerhub_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS $function$
  SELECT coalesce(nullif(current_setting('test.platform_admin', true), '') = 'true', false)
$function$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $function$
  SELECT nullif(current_setting('test.auth_uid', true), '')::uuid
$function$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.powerhub_has_tenant_access(bigint), private.powerhub_is_platform_admin() TO authenticated;

CREATE TABLE public.access_invitations (id bigint primary key, tenant_id bigint);
ALTER TABLE public.access_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.access_invitations FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.access_invitations TO anon, authenticated, service_role;
CREATE TABLE public.collector_sessions (id bigint primary key, tenant_id bigint);
ALTER TABLE public.collector_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.collector_sessions FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.collector_sessions TO anon, authenticated, service_role;
CREATE TABLE public.company_account_sites (id bigint primary key, tenant_id bigint);
ALTER TABLE public.company_account_sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.company_account_sites FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.company_account_sites TO anon, authenticated, service_role;
CREATE TABLE public.custom_permission_roles (id bigint primary key, tenant_id bigint);
ALTER TABLE public.custom_permission_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.custom_permission_roles FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.custom_permission_roles TO anon, authenticated, service_role;
CREATE TABLE public.employee_adjustments (id bigint primary key, tenant_id bigint);
ALTER TABLE public.employee_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.employee_adjustments FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.employee_adjustments TO anon, authenticated, service_role;
CREATE TABLE public.employee_attendance (id bigint primary key, tenant_id bigint);
ALTER TABLE public.employee_attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.employee_attendance FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.employee_attendance TO anon, authenticated, service_role;
CREATE TABLE public.employees (id bigint primary key, tenant_id bigint);
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.employees FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.employees TO anon, authenticated, service_role;
CREATE TABLE public.financial_settlements (id bigint primary key, tenant_id bigint);
ALTER TABLE public.financial_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.financial_settlements FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.financial_settlements TO anon, authenticated, service_role;
CREATE TABLE public.invoice_lines (id bigint primary key, tenant_id bigint);
ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.invoice_lines FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.invoice_lines TO anon, authenticated, service_role;
CREATE TABLE public.invoices (id bigint primary key, tenant_id bigint);
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.invoices FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.invoices TO anon, authenticated, service_role;
CREATE TABLE public.invoice_share_links (id bigint primary key, tenant_id bigint);
ALTER TABLE public.invoice_share_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.invoice_share_links FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.invoice_share_links TO anon, authenticated, service_role;
CREATE TABLE public.messaging_schedule_runs (id bigint primary key, tenant_id bigint);
ALTER TABLE public.messaging_schedule_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.messaging_schedule_runs FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.messaging_schedule_runs TO anon, authenticated, service_role;
CREATE TABLE public.mobile_api_sessions (id bigint primary key, tenant_id bigint);
ALTER TABLE public.mobile_api_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.mobile_api_sessions FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.mobile_api_sessions TO anon, authenticated, service_role;
CREATE TABLE public.mobile_sync_events (id bigint primary key, tenant_id bigint);
ALTER TABLE public.mobile_sync_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.mobile_sync_events FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.mobile_sync_events TO anon, authenticated, service_role;
CREATE TABLE public.notification_messages (id bigint primary key, tenant_id bigint);
ALTER TABLE public.notification_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.notification_messages FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.notification_messages TO anon, authenticated, service_role;
CREATE TABLE public.offline_sync_operations (id bigint primary key, tenant_id bigint);
ALTER TABLE public.offline_sync_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.offline_sync_operations FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.offline_sync_operations TO anon, authenticated, service_role;
CREATE TABLE public.payments (id bigint primary key, tenant_id bigint);
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.payments FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.payments TO anon, authenticated, service_role;
CREATE TABLE public.payroll_runs (id bigint primary key, tenant_id bigint);
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.payroll_runs FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.payroll_runs TO anon, authenticated, service_role;
CREATE TABLE public.site_portal_settings (id bigint primary key, tenant_id bigint);
ALTER TABLE public.site_portal_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.site_portal_settings FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.site_portal_settings TO anon, authenticated, service_role;
CREATE TABLE public.sms_package_requests (id bigint primary key, tenant_id bigint);
ALTER TABLE public.sms_package_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.sms_package_requests FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.sms_package_requests TO anon, authenticated, service_role;
CREATE TABLE public.staff_profiles (id bigint primary key, tenant_id bigint);
ALTER TABLE public.staff_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.staff_profiles FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.staff_profiles TO anon, authenticated, service_role;
CREATE TABLE public.subscribers (id bigint primary key, tenant_id bigint);
ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.subscribers FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.subscribers TO anon, authenticated, service_role;
CREATE TABLE public.subscription_upgrade_requests (id bigint primary key, tenant_id bigint);
ALTER TABLE public.subscription_upgrade_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.subscription_upgrade_requests FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.subscription_upgrade_requests TO anon, authenticated, service_role;
CREATE TABLE public.tariffs (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tariffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tariffs FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tariffs TO anon, authenticated, service_role;
CREATE TABLE public.tenant_branch_settings (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tenant_branch_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tenant_branch_settings FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tenant_branch_settings TO anon, authenticated, service_role;
CREATE TABLE public.tenant_messaging_configurations (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tenant_messaging_configurations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tenant_messaging_configurations FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tenant_messaging_configurations TO anon, authenticated, service_role;
CREATE TABLE public.tenant_owner_profiles (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tenant_owner_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tenant_owner_profiles FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tenant_owner_profiles TO anon, authenticated, service_role;
CREATE TABLE public.tenant_subscriptions (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tenant_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tenant_subscriptions FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tenant_subscriptions TO anon, authenticated, service_role;
CREATE TABLE public.tenant_invoice_message_templates (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tenant_invoice_message_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tenant_invoice_message_templates FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tenant_invoice_message_templates TO anon, authenticated, service_role;
CREATE TABLE public.tenant_payment_receipt_message_templates (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tenant_payment_receipt_message_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tenant_payment_receipt_message_templates FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tenant_payment_receipt_message_templates TO anon, authenticated, service_role;
CREATE TABLE public.tenant_tweetsms_accounts (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tenant_tweetsms_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tenant_tweetsms_accounts FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tenant_tweetsms_accounts TO anon, authenticated, service_role;
CREATE TABLE public.sites (id bigint primary key, tenant_id bigint);
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.sites FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.sites TO anon, authenticated, service_role;
CREATE TABLE public.inventory_items (id bigint primary key, tenant_id bigint);
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.inventory_items FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.inventory_items TO anon, authenticated, service_role;
CREATE TABLE public.inventory_stock_movements (id bigint primary key, tenant_id bigint);
ALTER TABLE public.inventory_stock_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.inventory_stock_movements FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.inventory_stock_movements TO anon, authenticated, service_role;
CREATE TABLE public.inventory_warehouses (id bigint primary key, tenant_id bigint);
ALTER TABLE public.inventory_warehouses ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.inventory_warehouses FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.inventory_warehouses TO anon, authenticated, service_role;
CREATE TABLE public.suppliers (id bigint primary key, tenant_id bigint);
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.suppliers FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.suppliers TO anon, authenticated, service_role;
CREATE TABLE public.supplier_purchases (id bigint primary key, tenant_id bigint);
ALTER TABLE public.supplier_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.supplier_purchases FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.supplier_purchases TO anon, authenticated, service_role;
CREATE TABLE public.supplier_purchase_lines (id bigint primary key, tenant_id bigint);
ALTER TABLE public.supplier_purchase_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.supplier_purchase_lines FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.supplier_purchase_lines TO anon, authenticated, service_role;
CREATE TABLE public.supplier_payments (id bigint primary key, tenant_id bigint);
ALTER TABLE public.supplier_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.supplier_payments FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.supplier_payments TO anon, authenticated, service_role;
CREATE TABLE public.supplier_payment_allocations (id bigint primary key, tenant_id bigint);
ALTER TABLE public.supplier_payment_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.supplier_payment_allocations FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.supplier_payment_allocations TO anon, authenticated, service_role;
CREATE TABLE public.supplier_ledger_entries (id bigint primary key, tenant_id bigint);
ALTER TABLE public.supplier_ledger_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.supplier_ledger_entries FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.supplier_ledger_entries TO anon, authenticated, service_role;
CREATE TABLE public.supplier_purchase_receipts (id bigint primary key, tenant_id bigint);
ALTER TABLE public.supplier_purchase_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.supplier_purchase_receipts FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.supplier_purchase_receipts TO anon, authenticated, service_role;
CREATE TABLE public.supplier_purchase_receipt_lines (id bigint primary key, tenant_id bigint);
ALTER TABLE public.supplier_purchase_receipt_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.supplier_purchase_receipt_lines FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.supplier_purchase_receipt_lines TO anon, authenticated, service_role;
CREATE TABLE public.tenant_members (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tenant_members FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tenant_members TO anon, authenticated, service_role;
CREATE TABLE public.platform_access_invitations (id bigint primary key, auth_user_id uuid);
ALTER TABLE public.platform_access_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.platform_access_invitations FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.platform_access_invitations TO anon, authenticated, service_role;
CREATE TABLE public.platform_role_policies (id bigint primary key, auth_user_id uuid);
ALTER TABLE public.platform_role_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.platform_role_policies FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.platform_role_policies TO anon, authenticated, service_role;
CREATE TABLE public.platform_settings (id bigint primary key, auth_user_id uuid);
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.platform_settings FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.platform_settings TO anon, authenticated, service_role;
CREATE TABLE public.platform_sms_fallback_providers (id bigint primary key, auth_user_id uuid);
ALTER TABLE public.platform_sms_fallback_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.platform_sms_fallback_providers FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.platform_sms_fallback_providers TO anon, authenticated, service_role;
CREATE TABLE public.platform_sms_plans (id bigint primary key, auth_user_id uuid);
ALTER TABLE public.platform_sms_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.platform_sms_plans FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.platform_sms_plans TO anon, authenticated, service_role;
CREATE TABLE public.platform_tweetsms_accounts (id bigint primary key, auth_user_id uuid);
ALTER TABLE public.platform_tweetsms_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.platform_tweetsms_accounts FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.platform_tweetsms_accounts TO anon, authenticated, service_role;
CREATE TABLE public.platform_tweetsms_balance_alerts (id bigint primary key, auth_user_id uuid);
ALTER TABLE public.platform_tweetsms_balance_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.platform_tweetsms_balance_alerts FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.platform_tweetsms_balance_alerts TO anon, authenticated, service_role;
CREATE TABLE public.payroll_items (id bigint primary key, payroll_run_id bigint);
ALTER TABLE public.payroll_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.payroll_items FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.payroll_items TO anon, authenticated, service_role;
CREATE TABLE public.payroll_adjustment_allocations (id bigint primary key, payroll_run_id bigint);
ALTER TABLE public.payroll_adjustment_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.payroll_adjustment_allocations FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.payroll_adjustment_allocations TO anon, authenticated, service_role;
CREATE TABLE public.tenants (id bigint primary key);
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tenants FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tenants TO anon, authenticated, service_role;
CREATE TABLE public.users (id bigint primary key, auth_user_id uuid);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.users FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.users TO anon, authenticated, service_role;

CREATE TABLE public.emergency_requests (id bigint primary key, tenant_id bigint);
ALTER TABLE public.emergency_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.emergency_requests FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.emergency_requests TO anon, authenticated, service_role;
CREATE TABLE public.sms_dispatch_queue (id bigint primary key, tenant_id bigint);
ALTER TABLE public.sms_dispatch_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.sms_dispatch_queue FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.sms_dispatch_queue TO anon, authenticated, service_role;
CREATE TABLE public.tweet_sms_report_snapshots (id bigint primary key, tenant_id bigint);
ALTER TABLE public.tweet_sms_report_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_open ON public.tweet_sms_report_snapshots FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
GRANT ALL ON public.tweet_sms_report_snapshots TO anon, authenticated, service_role;

\ir ../migrations/20261030210000_powerhub_canonical_tenant_rls_policy_reconcile.sql
\ir ../migrations/20261030210000_powerhub_canonical_tenant_rls_policy_reconcile.sql

INSERT INTO public.tenants(id) VALUES (1), (2);
INSERT INTO public.employees(id,tenant_id) VALUES (1,1), (2,2);
INSERT INTO public.payroll_runs(id,tenant_id) VALUES (1,1), (2,2);
INSERT INTO public.payroll_items(id,payroll_run_id) VALUES (1,1), (2,2);
INSERT INTO public.platform_settings(id) VALUES (1), (2);
INSERT INTO public.users(id,auth_user_id) VALUES
  (1,'11111111-1111-4111-8111-111111111111'),
  (2,'22222222-2222-4222-8222-222222222222');

SET ROLE authenticated;
SET test.tenant_id = '1';
SET test.auth_uid = '11111111-1111-4111-8111-111111111111';
SET test.platform_admin = 'false';

DO $behavior$
BEGIN
  IF (SELECT count(*) FROM public.employees) <> 1
     OR (SELECT count(*) FROM public.payroll_items) <> 1
     OR (SELECT count(*) FROM public.tenants) <> 1
     OR (SELECT count(*) FROM public.users) <> 1
     OR (SELECT count(*) FROM public.platform_settings) <> 0 THEN
    RAISE EXCEPTION 'CANONICAL_RLS_READ_SCOPE_MISMATCH';
  END IF;

  BEGIN
    INSERT INTO public.employees(id,tenant_id) VALUES (99,2);
    RAISE EXCEPTION 'CROSS_TENANT_EMPLOYEE_INSERT_WAS_ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.payroll_items(id,payroll_run_id) VALUES (99,2);
    RAISE EXCEPTION 'CROSS_TENANT_PAYROLL_ITEM_INSERT_WAS_ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.suppliers(id,tenant_id) VALUES (99,1);
    RAISE EXCEPTION 'READ_ONLY_SUPPLIER_POLICY_ALLOWED_INSERT';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.inventory_items(id,tenant_id) VALUES (99,1);
    RAISE EXCEPTION 'READ_ONLY_INVENTORY_POLICY_ALLOWED_INSERT';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$behavior$;

SET test.platform_admin = 'true';
DO $platform_admin$
BEGIN
  IF (SELECT count(*) FROM public.platform_settings) <> 2 THEN
    RAISE EXCEPTION 'PLATFORM_ADMIN_POLICY_SCOPE_MISMATCH';
  END IF;
END
$platform_admin$;
RESET ROLE;

DO $assert$
DECLARE
  v record;
  v_command text;
  v_expected text;
  v_expected_policy text;
  v_target constant text[] := ARRAY['access_invitations','collector_sessions','company_account_sites','custom_permission_roles','employee_adjustments','employee_attendance','employees','financial_settlements','invoice_lines','invoices','invoice_share_links','messaging_schedule_runs','mobile_api_sessions','mobile_sync_events','notification_messages','offline_sync_operations','payments','payroll_runs','site_portal_settings','sms_package_requests','staff_profiles','subscribers','subscription_upgrade_requests','tariffs','tenant_branch_settings','tenant_messaging_configurations','tenant_owner_profiles','tenant_subscriptions','tenant_invoice_message_templates','tenant_payment_receipt_message_templates','tenant_tweetsms_accounts','sites','inventory_items','inventory_stock_movements','inventory_warehouses','suppliers','supplier_purchases','supplier_purchase_lines','supplier_payments','supplier_payment_allocations','supplier_ledger_entries','supplier_purchase_receipts','supplier_purchase_receipt_lines','tenant_members','platform_access_invitations','platform_role_policies','platform_settings','platform_sms_fallback_providers','platform_sms_plans','platform_tweetsms_accounts','platform_tweetsms_balance_alerts','payroll_items','payroll_adjustment_allocations','tenants','users'];
BEGIN
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY(v_target)) <> cardinality(v_target) THEN
    RAISE EXCEPTION 'CANONICAL_RLS_POLICY_COUNT_MISMATCH';
  END IF;
  FOREACH v_expected IN ARRAY v_target LOOP
    SELECT p.polcmd::text INTO v_command
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=v_expected;
    v_expected_policy := CASE
      WHEN v_expected = 'tenant_members' THEN 'tenant_members_member_read'
      WHEN v_expected = 'tenant_tweetsms_accounts' THEN 'tenant_tweetsms_tenant_isolation'
      WHEN v_expected = 'platform_sms_fallback_providers' THEN 'platform_sms_fallback_admin_only'
      WHEN v_expected = 'platform_tweetsms_accounts' THEN 'platform_tweetsms_admin_only'
      WHEN v_expected = 'platform_tweetsms_balance_alerts' THEN 'platform_tweetsms_alert_admin_only'
      WHEN v_expected = 'tenants' THEN 'tenants_member_read'
      WHEN v_expected = 'users' THEN 'users_self_read'
      WHEN v_expected IN ('inventory_items','inventory_stock_movements','inventory_warehouses','suppliers',
        'supplier_purchases','supplier_purchase_lines','supplier_payments','supplier_payment_allocations',
        'supplier_ledger_entries','supplier_purchase_receipts','supplier_purchase_receipt_lines')
        THEN v_expected || '_tenant_read'
      WHEN v_expected IN ('platform_access_invitations','platform_role_policies','platform_settings','platform_sms_plans')
        THEN v_expected || '_platform_admin_only'
      ELSE v_expected || '_tenant_isolation'
    END;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_expected AND p.polname=v_expected_policy
        AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='authenticated')]::oid[]
    ) THEN RAISE EXCEPTION 'CANONICAL_RLS_POLICY_NAME_OR_ROLE_MISMATCH: %',v_expected; END IF;
    IF v_command NOT IN ('*','r') THEN RAISE EXCEPTION 'CANONICAL_RLS_COMMAND_MISMATCH: %',v_expected; END IF;
  END LOOP;
  FOREACH v_expected IN ARRAY ARRAY['emergency_requests','sms_dispatch_queue','tweet_sms_report_snapshots'] LOOP
    IF EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname=v_expected) THEN
      RAISE EXCEPTION 'LEGACY_BROWSER_POLICY_REMAINS: %',v_expected;
    END IF;
    IF has_table_privilege('anon',format('public.%I',v_expected),'SELECT')
       OR has_table_privilege('authenticated',format('public.%I',v_expected),'SELECT')
       OR has_table_privilege('anon',format('public.%I',v_expected),'INSERT')
       OR has_table_privilege('authenticated',format('public.%I',v_expected),'INSERT') THEN
      RAISE EXCEPTION 'LEGACY_BROWSER_PRIVILEGE_REMAINS: %',v_expected;
    END IF;
    IF NOT has_table_privilege('service_role',format('public.%I',v_expected),'INSERT') THEN
      RAISE EXCEPTION 'LEGACY_SERVICE_ROLE_GRANT_REMOVED: %',v_expected;
    END IF;
  END LOOP;
END
$assert$;

SELECT 'canonical tenant RLS policy reconciliation passed for 55 tables and 3 legacy tables' AS result;
