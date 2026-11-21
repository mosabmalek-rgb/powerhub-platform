-- Staging had retained broad browser-role DML grants on tenant-scoped tables
-- whose writes are performed by server-side, capability-checked routes/RPCs.
-- Revoke mutation only. Keep SELECT, existing RLS policies, and service_role
-- grants untouched. Optional staging-only tables are skipped on production.
DO $reconcile_browser_dml$
DECLARE
  v_table text;
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
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM PUBLIC, anon, authenticated',
        v_table
      );
    END IF;
  END LOOP;
END
$reconcile_browser_dml$;
