-- Scope authenticated financial reads to the user's actual PowerHub site assignments.
-- Tenant owners and active platform administrators retain their established wider scope.
-- Server-only financial ledgers remain server-only; this migration does not add table grants.

DO $preflight$
BEGIN
  IF to_regprocedure('private.powerhub_current_user_id()') IS NULL
     OR to_regprocedure('private.powerhub_is_platform_admin()') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
     OR to_regclass('public.tenant_members') IS NULL
     OR to_regclass('public.staff_profiles') IS NULL
     OR to_regclass('public.company_account_sites') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_FINANCIAL_SITE_RLS_PREREQUISITES_MISSING';
  END IF;
  IF NOT has_schema_privilege('authenticated','private','USAGE')
     OR NOT has_function_privilege('authenticated','private.powerhub_current_user_id()','EXECUTE')
     OR NOT has_function_privilege('authenticated','private.powerhub_is_platform_admin()','EXECUTE') THEN
    RAISE EXCEPTION 'POWERHUB_FINANCIAL_SITE_RLS_HELPER_GRANTS_MISSING';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION private.powerhub_has_site_access(
  target_tenant_id bigint,
  target_site_id bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (SELECT private.powerhub_is_platform_admin())
    OR (
      target_tenant_id IS NOT NULL
      AND (
        target_site_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.sites s
          WHERE s.id = target_site_id
            AND s.tenant_id = target_tenant_id
        )
      )
      AND EXISTS (
        SELECT 1
        FROM public.tenant_members membership
        JOIN public.users account
          ON account.id = membership.user_id
        WHERE membership.tenant_id = target_tenant_id
          AND membership.user_id = (SELECT private.powerhub_current_user_id())
          AND account.auth_user_id = (SELECT auth.uid())
          AND account.account_status = 'active'
          AND membership.is_active = true
          AND membership.membership_status = 'active'
          AND (membership.expires_at IS NULL OR membership.expires_at > now())
          AND (
            membership.role = 'owner'
            OR CASE
              WHEN target_site_id IS NULL THEN
                EXISTS (
                  SELECT 1
                  FROM public.staff_profiles profile
                  WHERE profile.tenant_id = target_tenant_id
                    AND profile.user_id = membership.user_id
                    AND profile.site_id IS NULL
                    AND profile.is_active = true
                    AND profile.archived_at IS NULL
                    AND NOT (
                      profile.suspension_started_at IS NOT NULL
                      AND profile.suspension_ends_at IS NOT NULL
                      AND now() >= profile.suspension_started_at
                      AND now() < profile.suspension_ends_at
                    )
                )
              WHEN EXISTS (
                SELECT 1
                FROM public.staff_profiles exact_profile
                WHERE exact_profile.tenant_id = target_tenant_id
                  AND exact_profile.user_id = membership.user_id
                  AND exact_profile.site_id = target_site_id
                  AND exact_profile.is_active = true
                  AND exact_profile.archived_at IS NULL
              ) THEN
                EXISTS (
                  SELECT 1
                  FROM public.staff_profiles exact_profile
                  WHERE exact_profile.tenant_id = target_tenant_id
                    AND exact_profile.user_id = membership.user_id
                    AND exact_profile.site_id = target_site_id
                    AND exact_profile.is_active = true
                    AND exact_profile.archived_at IS NULL
                    AND NOT (
                      exact_profile.suspension_started_at IS NOT NULL
                      AND exact_profile.suspension_ends_at IS NOT NULL
                      AND now() >= exact_profile.suspension_started_at
                      AND now() < exact_profile.suspension_ends_at
                    )
                )
              ELSE
                EXISTS (
                  SELECT 1
                  FROM public.staff_profiles global_profile
                  WHERE global_profile.tenant_id = target_tenant_id
                    AND global_profile.user_id = membership.user_id
                    AND global_profile.site_id IS NULL
                    AND global_profile.is_active = true
                    AND global_profile.archived_at IS NULL
                    AND NOT (
                      global_profile.suspension_started_at IS NOT NULL
                      AND global_profile.suspension_ends_at IS NOT NULL
                      AND now() >= global_profile.suspension_started_at
                      AND now() < global_profile.suspension_ends_at
                    )
                )
            END
          )
      )
    );
$function$;

CREATE OR REPLACE FUNCTION private.powerhub_has_company_account_access(
  target_tenant_id bigint,
  target_account_id bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (SELECT private.powerhub_is_platform_admin())
    OR EXISTS (
      SELECT 1
      FROM public.company_accounts account
      WHERE account.tenant_id = target_tenant_id
        AND account.id = target_account_id
        AND (
          EXISTS (
            SELECT 1
            FROM public.company_account_sites mapping
            WHERE mapping.tenant_id = account.tenant_id
              AND mapping.account_id = account.id
              AND private.powerhub_has_site_access(mapping.tenant_id, mapping.site_id)
          )
          OR (
            NOT EXISTS (
              SELECT 1
              FROM public.company_account_sites mapping
              WHERE mapping.tenant_id = account.tenant_id
                AND mapping.account_id = account.id
            )
            AND (
              private.powerhub_has_site_access(account.tenant_id, NULL)
              OR EXISTS (
                SELECT 1
                FROM public.sites site
                WHERE site.tenant_id = account.tenant_id
                  AND private.powerhub_has_site_access(site.tenant_id, site.id)
              )
            )
          )
        )
    );
$function$;

REVOKE ALL ON FUNCTION private.powerhub_has_site_access(bigint,bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.powerhub_has_company_account_access(bigint,bigint) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.powerhub_has_site_access(bigint,bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.powerhub_has_company_account_access(bigint,bigint) TO authenticated, service_role;

-- Policy helper lookups and parent-row predicates must remain index-backed.
CREATE INDEX IF NOT EXISTS staff_profiles_tenant_user_site_live_idx
  ON public.staff_profiles(tenant_id,user_id,site_id)
  WHERE is_active = true AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS company_account_sites_tenant_site_account_idx
  ON public.company_account_sites(tenant_id,site_id,account_id);
CREATE INDEX IF NOT EXISTS invoice_lines_tenant_invoice_idx
  ON public.invoice_lines(tenant_id,invoice_id);
CREATE INDEX IF NOT EXISTS financial_settlements_tenant_site_idx
  ON public.financial_settlements(tenant_id,site_id);
CREATE INDEX IF NOT EXISTS payroll_runs_tenant_site_idx
  ON public.payroll_runs(tenant_id,site_id);

DO $replace_site_policies$
DECLARE
  target record;
  old_policy record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('account_transactions',
       'private.powerhub_has_company_account_access(tenant_id,account_id)'),
      ('company_accounts',
       'private.powerhub_has_company_account_access(tenant_id,id)'),
      ('company_account_sites',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('audit_logs',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('expenses',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('financial_settlements',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('invoices',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('payments',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('employees',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('employee_adjustments',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('employee_attendance',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('payroll_runs',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('supplier_ledger_entries',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('supplier_payments',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('supplier_purchases',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('supplier_purchase_receipts',
       'private.powerhub_has_site_access(tenant_id,site_id)'),
      ('supplier_purchase_returns',
       'private.powerhub_has_site_access(tenant_id,site_id)')
    ) AS targets(table_name,predicate)
  LOOP
    IF to_regclass(format('public.%I',target.table_name)) IS NULL THEN
      RAISE EXCEPTION 'FINANCIAL_SITE_RLS_TABLE_MISSING: %',target.table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      WHERE c.oid = to_regclass(format('public.%I',target.table_name))
        AND c.relrowsecurity = true
    ) THEN
      RAISE EXCEPTION 'FINANCIAL_SITE_RLS_DISABLED: %',target.table_name;
    END IF;
    FOR old_policy IN
      SELECT polname
      FROM pg_policy
      WHERE polrelid = to_regclass(format('public.%I',target.table_name))
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',old_policy.polname,target.table_name);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
      target.table_name || '_site_scope_read',
      target.table_name,
      target.predicate
    );
  END LOOP;
END
$replace_site_policies$;

-- Child financial rows derive their site from the authoritative parent row.
DO $replace_child_policies$
DECLARE
  target record;
  old_policy record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('invoice_lines',
       'EXISTS (SELECT 1 FROM public.invoices parent WHERE parent.tenant_id=invoice_lines.tenant_id AND parent.id=invoice_lines.invoice_id AND private.powerhub_has_site_access(parent.tenant_id,parent.site_id))'),
      ('payroll_items',
       'EXISTS (SELECT 1 FROM public.payroll_runs parent JOIN public.employees employee ON employee.id=payroll_items.employee_id AND employee.tenant_id=parent.tenant_id WHERE parent.id=payroll_items.payroll_run_id AND private.powerhub_has_site_access(parent.tenant_id,parent.site_id) AND (employee.site_id IS NULL OR employee.site_id=parent.site_id))'),
      ('payroll_adjustment_allocations',
       'EXISTS (SELECT 1 FROM public.payroll_runs parent JOIN public.employee_adjustments adjustment ON adjustment.id=payroll_adjustment_allocations.adjustment_id AND adjustment.tenant_id=parent.tenant_id WHERE parent.id=payroll_adjustment_allocations.payroll_run_id AND private.powerhub_has_site_access(parent.tenant_id,parent.site_id) AND private.powerhub_has_site_access(adjustment.tenant_id,adjustment.site_id))'),
      ('supplier_purchase_lines',
       'EXISTS (SELECT 1 FROM public.supplier_purchases parent WHERE parent.tenant_id=supplier_purchase_lines.tenant_id AND parent.id=supplier_purchase_lines.purchase_id AND private.powerhub_has_site_access(parent.tenant_id,parent.site_id))'),
      ('supplier_purchase_receipt_lines',
       'EXISTS (SELECT 1 FROM public.supplier_purchase_receipts receipt JOIN public.supplier_purchases purchase ON purchase.tenant_id=receipt.tenant_id AND purchase.id=receipt.purchase_id WHERE receipt.tenant_id=supplier_purchase_receipt_lines.tenant_id AND receipt.id=supplier_purchase_receipt_lines.receipt_id AND purchase.id=supplier_purchase_receipt_lines.purchase_id AND private.powerhub_has_site_access(receipt.tenant_id,receipt.site_id) AND private.powerhub_has_site_access(purchase.tenant_id,purchase.site_id))'),
      ('supplier_purchase_return_lines',
       'EXISTS (SELECT 1 FROM public.supplier_purchase_returns returned JOIN public.supplier_purchases purchase ON purchase.tenant_id=returned.tenant_id AND purchase.id=returned.purchase_id WHERE returned.tenant_id=supplier_purchase_return_lines.tenant_id AND returned.id=supplier_purchase_return_lines.return_id AND purchase.id=supplier_purchase_return_lines.purchase_id AND private.powerhub_has_site_access(returned.tenant_id,returned.site_id) AND private.powerhub_has_site_access(purchase.tenant_id,purchase.site_id))'),
      ('supplier_payment_allocations',
       'EXISTS (SELECT 1 FROM public.supplier_payments payment WHERE payment.tenant_id=supplier_payment_allocations.tenant_id AND payment.id=supplier_payment_allocations.payment_id AND private.powerhub_has_site_access(payment.tenant_id,payment.site_id)) AND (supplier_payment_allocations.purchase_id IS NULL OR EXISTS (SELECT 1 FROM public.supplier_purchases purchase WHERE purchase.tenant_id=supplier_payment_allocations.tenant_id AND purchase.id=supplier_payment_allocations.purchase_id AND private.powerhub_has_site_access(purchase.tenant_id,purchase.site_id))) AND (supplier_payment_allocations.supplier_ledger_entry_id IS NULL OR EXISTS (SELECT 1 FROM public.supplier_ledger_entries entry WHERE entry.tenant_id=supplier_payment_allocations.tenant_id AND entry.id=supplier_payment_allocations.supplier_ledger_entry_id AND private.powerhub_has_site_access(entry.tenant_id,entry.site_id)))')
    ) AS targets(table_name,predicate)
  LOOP
    IF to_regclass(format('public.%I',target.table_name)) IS NULL THEN
      RAISE EXCEPTION 'FINANCIAL_SITE_RLS_CHILD_TABLE_MISSING: %',target.table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      WHERE c.oid = to_regclass(format('public.%I',target.table_name))
        AND c.relrowsecurity = true
    ) THEN
      RAISE EXCEPTION 'FINANCIAL_SITE_RLS_CHILD_DISABLED: %',target.table_name;
    END IF;
    FOR old_policy IN
      SELECT polname
      FROM pg_policy
      WHERE polrelid = to_regclass(format('public.%I',target.table_name))
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',old_policy.polname,target.table_name);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
      target.table_name || '_site_scope_read',
      target.table_name,
      target.predicate
    );
  END LOOP;
END
$replace_child_policies$;

-- These financial ledgers intentionally remain server-only: no authenticated SELECT grant
-- and no browser RLS policy are added to them by this migration.
DO $assert_server_only_ledgers$
BEGIN
  IF has_table_privilege('authenticated','public.subscriber_balance_ledger','SELECT')
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='subscriber_balance_ledger') THEN
    RAISE EXCEPTION 'SUBSCRIBER_BALANCE_LEDGER_MUST_REMAIN_SERVER_ONLY';
  END IF;
  IF has_table_privilege('authenticated','public.employee_adjustment_repayments','SELECT') THEN
    RAISE EXCEPTION 'EMPLOYEE_ADJUSTMENT_REPAYMENTS_MUST_REMAIN_SERVER_ONLY';
  END IF;
END
$assert_server_only_ledgers$;

NOTIFY pgrst, 'reload schema';
