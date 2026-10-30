-- Reconcile Staging RLS policy drift to the canonical Production access boundary.
-- The earlier ACL reconciliation removed browser DML grants; this migration also
-- replaces broad PUBLIC/legacy helper policies with one authenticated-only policy
-- per table. Existing data, columns, constraints, ACLs, and service_role grants
-- are deliberately untouched.

DO $preflight$
BEGIN
  IF to_regprocedure('private.powerhub_has_tenant_access(bigint)') IS NULL
     OR to_regprocedure('private.powerhub_is_platform_admin()') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_CANONICAL_RLS_HELPERS_MISSING';
  END IF;
  IF NOT has_schema_privilege('authenticated', 'private', 'USAGE')
     OR NOT has_function_privilege('authenticated', 'private.powerhub_has_tenant_access(bigint)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'private.powerhub_is_platform_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POWERHUB_CANONICAL_RLS_HELPER_GRANTS_MISSING';
  END IF;
  IF has_function_privilege('anon', 'private.powerhub_has_tenant_access(bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.powerhub_is_platform_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POWERHUB_ANON_RLS_HELPER_EXECUTE_MUST_REMAIN_REVOKED';
  END IF;
END
$preflight$;

DO $reconcile_policies$
DECLARE
  v_target record;
  v_policy record;
  v_policy_name text;
  v_predicate text;
  v_target_tables constant text[] := ARRAY[
    'access_invitations',
    'collector_sessions',
    'company_account_sites',
    'custom_permission_roles',
    'employee_adjustments',
    'employee_attendance',
    'employees',
    'financial_settlements',
    'invoice_lines',
    'invoices',
    'invoice_share_links',
    'messaging_schedule_runs',
    'mobile_api_sessions',
    'mobile_sync_events',
    'notification_messages',
    'offline_sync_operations',
    'payments',
    'payroll_runs',
    'site_portal_settings',
    'sms_package_requests',
    'staff_profiles',
    'subscribers',
    'subscription_upgrade_requests',
    'tariffs',
    'tenant_branch_settings',
    'tenant_messaging_configurations',
    'tenant_owner_profiles',
    'tenant_subscriptions',
    'tenant_invoice_message_templates',
    'tenant_payment_receipt_message_templates',
    'tenant_tweetsms_accounts',
    'sites',
    'inventory_items',
    'inventory_stock_movements',
    'inventory_warehouses',
    'suppliers',
    'supplier_purchases',
    'supplier_purchase_lines',
    'supplier_payments',
    'supplier_payment_allocations',
    'supplier_ledger_entries',
    'supplier_purchase_receipts',
    'supplier_purchase_receipt_lines',
    'tenant_members',
    'platform_access_invitations',
    'platform_role_policies',
    'platform_settings',
    'platform_sms_fallback_providers',
    'platform_sms_plans',
    'platform_tweetsms_accounts',
    'platform_tweetsms_balance_alerts',
    'payroll_items',
    'payroll_adjustment_allocations',
    'tenants',
    'users'
  ];
BEGIN
  FOR v_target IN
    SELECT * FROM (VALUES
      ('access_invitations', 'tenant_all'),
      ('collector_sessions', 'tenant_all'),
      ('company_account_sites', 'tenant_all'),
      ('custom_permission_roles', 'tenant_all'),
      ('employee_adjustments', 'tenant_all'),
      ('employee_attendance', 'tenant_all'),
      ('employees', 'tenant_all'),
      ('financial_settlements', 'tenant_all'),
      ('invoice_lines', 'tenant_all'),
      ('invoices', 'tenant_all'),
      ('invoice_share_links', 'tenant_all'),
      ('messaging_schedule_runs', 'tenant_all'),
      ('mobile_api_sessions', 'tenant_all'),
      ('mobile_sync_events', 'tenant_all'),
      ('notification_messages', 'tenant_all'),
      ('offline_sync_operations', 'tenant_all'),
      ('payments', 'tenant_all'),
      ('payroll_runs', 'tenant_all'),
      ('site_portal_settings', 'tenant_all'),
      ('sms_package_requests', 'tenant_all'),
      ('staff_profiles', 'tenant_all'),
      ('subscribers', 'tenant_all'),
      ('subscription_upgrade_requests', 'tenant_all'),
      ('tariffs', 'tenant_all'),
      ('tenant_branch_settings', 'tenant_all'),
      ('tenant_messaging_configurations', 'tenant_all'),
      ('tenant_owner_profiles', 'tenant_all'),
      ('tenant_subscriptions', 'tenant_all'),
      ('tenant_invoice_message_templates', 'tenant_all'),
      ('tenant_payment_receipt_message_templates', 'tenant_all'),
      ('tenant_tweetsms_accounts', 'tenant_all'),
      ('sites', 'tenant_all'),
      ('inventory_items', 'tenant_read'),
      ('inventory_stock_movements', 'tenant_read'),
      ('inventory_warehouses', 'tenant_read'),
      ('suppliers', 'tenant_read'),
      ('supplier_purchases', 'tenant_read'),
      ('supplier_purchase_lines', 'tenant_read'),
      ('supplier_payments', 'tenant_read'),
      ('supplier_payment_allocations', 'tenant_read'),
      ('supplier_ledger_entries', 'tenant_read'),
      ('supplier_purchase_receipts', 'tenant_read'),
      ('supplier_purchase_receipt_lines', 'tenant_read'),
      ('tenant_members', 'tenant_read'),
      ('platform_access_invitations', 'platform_all'),
      ('platform_role_policies', 'platform_all'),
      ('platform_settings', 'platform_all'),
      ('platform_sms_fallback_providers', 'platform_all'),
      ('platform_sms_plans', 'platform_all'),
      ('platform_tweetsms_accounts', 'platform_all'),
      ('platform_tweetsms_balance_alerts', 'platform_all'),
      ('payroll_items', 'payroll_parent_all'),
      ('payroll_adjustment_allocations', 'payroll_parent_all'),
      ('tenants', 'tenant_id_read'),
      ('users', 'users_read')
    ) AS targets(table_name, policy_kind)
  LOOP
    IF to_regclass(format('public.%I', v_target.table_name)) IS NULL THEN
      RAISE EXCEPTION 'POWERHUB_CANONICAL_RLS_TABLE_MISSING: %', v_target.table_name;
    END IF;

    -- Drop every policy on the target table, not just the expected legacy name.
    -- This prevents an untracked permissive policy from surviving the reconcile.
    FOR v_policy IN
      SELECT polname FROM pg_policy WHERE polrelid = to_regclass(format('public.%I', v_target.table_name))
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', v_policy.polname, v_target.table_name);
    END LOOP;

    v_policy_name := CASE
      WHEN v_target.table_name = 'tenant_members' THEN 'tenant_members_member_read'
      WHEN v_target.table_name = 'tenant_tweetsms_accounts' THEN 'tenant_tweetsms_tenant_isolation'
      WHEN v_target.table_name = 'platform_sms_fallback_providers' THEN 'platform_sms_fallback_admin_only'
      WHEN v_target.table_name = 'platform_tweetsms_accounts' THEN 'platform_tweetsms_admin_only'
      WHEN v_target.table_name = 'platform_tweetsms_balance_alerts' THEN 'platform_tweetsms_alert_admin_only'
      WHEN v_target.policy_kind = 'tenant_all' THEN v_target.table_name || '_tenant_isolation'
      WHEN v_target.policy_kind = 'tenant_read' THEN v_target.table_name || '_tenant_read'
      WHEN v_target.policy_kind = 'platform_all' THEN v_target.table_name || '_platform_admin_only'
      WHEN v_target.policy_kind = 'payroll_parent_all' THEN v_target.table_name || '_tenant_isolation'
      WHEN v_target.policy_kind = 'tenant_id_read' THEN 'tenants_member_read'
      WHEN v_target.policy_kind = 'users_read' THEN 'users_self_read'
      ELSE NULL
    END;

    IF v_policy_name IS NULL THEN
      RAISE EXCEPTION 'POWERHUB_CANONICAL_RLS_POLICY_KIND_UNSUPPORTED: %', v_target.policy_kind;
    END IF;

    IF v_target.policy_kind = 'tenant_all' THEN
      v_predicate := '(private.powerhub_has_tenant_access(tenant_id) OR private.powerhub_is_platform_admin())';
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
        v_policy_name, v_target.table_name, v_predicate, v_predicate
      );
    ELSIF v_target.policy_kind = 'tenant_read' THEN
      v_predicate := '(private.powerhub_has_tenant_access(tenant_id) OR private.powerhub_is_platform_admin())';
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
        v_policy_name, v_target.table_name, v_predicate
      );
    ELSIF v_target.policy_kind = 'platform_all' THEN
      v_predicate := 'private.powerhub_is_platform_admin()';
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
        v_policy_name, v_target.table_name, v_predicate, v_predicate
      );
    ELSIF v_target.policy_kind = 'payroll_parent_all' THEN
      IF v_target.table_name = 'payroll_items' THEN
        v_predicate := 'EXISTS (SELECT 1 FROM public.payroll_runs payroll WHERE payroll.id = payroll_items.payroll_run_id AND (private.powerhub_has_tenant_access(payroll.tenant_id) OR private.powerhub_is_platform_admin()))';
      ELSE
        v_predicate := 'EXISTS (SELECT 1 FROM public.payroll_runs pr WHERE pr.id = payroll_adjustment_allocations.payroll_run_id AND (private.powerhub_has_tenant_access(pr.tenant_id) OR private.powerhub_is_platform_admin()))';
      END IF;
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (%s) WITH CHECK (%s)',
        v_policy_name, v_target.table_name, v_predicate, v_predicate
      );
    ELSIF v_target.policy_kind = 'tenant_id_read' THEN
      v_predicate := '(private.powerhub_has_tenant_access(id) OR private.powerhub_is_platform_admin())';
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
        v_policy_name, v_target.table_name, v_predicate
      );
    ELSIF v_target.policy_kind = 'users_read' THEN
      v_predicate := '((auth_user_id = (SELECT auth.uid())) OR private.powerhub_is_platform_admin())';
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
        v_policy_name, v_target.table_name, v_predicate
      );
    END IF;
  END LOOP;

  -- These three legacy Staging-only tables have no application references or
  -- Production counterpart. Keep the tables and service_role access, but deny
  -- every direct browser privilege and remove obsolete browser RLS policies.
  FOREACH v_policy_name IN ARRAY ARRAY['emergency_requests','sms_dispatch_queue','tweet_sms_report_snapshots'] LOOP
    IF to_regclass(format('public.%I', v_policy_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_policy_name);
      FOR v_policy IN
        SELECT polname FROM pg_policy WHERE polrelid = to_regclass(format('public.%I', v_policy_name))
      LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', v_policy.polname, v_policy_name);
      END LOOP;
    END IF;
  END LOOP;
END
$reconcile_policies$;
