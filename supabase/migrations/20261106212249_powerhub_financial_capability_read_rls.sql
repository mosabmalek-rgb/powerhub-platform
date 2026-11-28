-- Separate site membership from financial read capability at direct PostgREST boundaries.
-- Invoice/payment collection remains available to collectors; expenses, cash ledgers,
-- deposits and financial reports require explicit financial visibility or management.
CREATE OR REPLACE FUNCTION private.powerhub_has_site_capability(
  target_tenant_id bigint,
  target_site_id bigint,
  target_capability text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id bigint;
  v_membership_role text;
  v_effective_role text;
  v_profile public.staff_profiles%ROWTYPE;
  v_custom_permissions jsonb;
  v_has_capability boolean := false;
  v_override boolean;
BEGIN
  IF target_tenant_id IS NULL
     OR target_capability IS NULL
     OR target_capability NOT IN ('managePayroll','manageExpenses','viewFinancialReports','issueInvoices','collectPayments') THEN
    RETURN false;
  END IF;

  IF target_site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sites site
    WHERE site.id=target_site_id AND site.tenant_id=target_tenant_id
  ) THEN
    RETURN false;
  END IF;

  IF COALESCE((SELECT private.powerhub_is_platform_admin()),false) THEN
    RETURN true;
  END IF;

  v_user_id := private.powerhub_current_user_id();
  IF v_user_id IS NULL OR (SELECT auth.uid()) IS NULL THEN
    RETURN false;
  END IF;

  SELECT membership.role INTO v_membership_role
  FROM public.tenant_members membership
  JOIN public.users account
    ON account.id=membership.user_id
   AND account.auth_user_id=(SELECT auth.uid())
  WHERE membership.tenant_id=target_tenant_id
    AND membership.user_id=v_user_id
    AND account.account_status='active'
    AND membership.is_active=true
    AND membership.membership_status='active'
    AND (membership.expires_at IS NULL OR membership.expires_at>now())
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_membership_role='owner' THEN
    v_effective_role := 'owner';
    v_has_capability := true;
    SELECT member_override.is_allowed INTO v_override
    FROM public.tenant_member_capability_overrides member_override
    WHERE member_override.tenant_id=target_tenant_id
      AND member_override.user_id=v_user_id
      AND member_override.capability=target_capability;
    IF FOUND THEN
      v_has_capability := v_override;
    END IF;
  ELSE
    SELECT profile.* INTO v_profile
    FROM public.staff_profiles profile
    WHERE profile.tenant_id=target_tenant_id
      AND profile.user_id=v_user_id
      AND profile.is_active=true
      AND profile.archived_at IS NULL
      AND (
        (target_site_id IS NULL AND profile.site_id IS NULL)
        OR
        (target_site_id IS NOT NULL AND (profile.site_id=target_site_id OR profile.site_id IS NULL))
      )
    ORDER BY
      CASE WHEN target_site_id IS NOT NULL AND profile.site_id=target_site_id THEN 0 ELSE 1 END,
      profile.id
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN false;
    END IF;

    -- Exact-site profile wins even when suspended; do not fall back to global access.
    IF v_profile.suspension_started_at IS NOT NULL
       AND v_profile.suspension_ends_at IS NOT NULL
       AND now()>=v_profile.suspension_started_at
       AND now()<v_profile.suspension_ends_at THEN
      RETURN false;
    END IF;

    v_effective_role := v_profile.role;

    -- NULL inherits custom/default role; [] explicitly denies all capabilities.
    IF v_profile.permissions IS NOT NULL THEN
      v_has_capability := v_profile.permissions @> pg_catalog.jsonb_build_array(target_capability);
    ELSIF v_profile.custom_role_id IS NOT NULL THEN
      SELECT custom_role.permissions INTO v_custom_permissions
      FROM public.custom_permission_roles custom_role
      WHERE custom_role.id=v_profile.custom_role_id
        AND custom_role.tenant_id=target_tenant_id
        AND custom_role.is_active=true;
      v_has_capability := FOUND
        AND COALESCE(v_custom_permissions @> pg_catalog.jsonb_build_array(target_capability),false);
    ELSE
      v_has_capability := CASE target_capability
        WHEN 'managePayroll' THEN v_effective_role IN ('owner','accountant')
        WHEN 'manageExpenses' THEN v_effective_role IN ('owner','manager','accountant')
        WHEN 'viewFinancialReports' THEN v_effective_role IN ('owner','manager','accountant')
        WHEN 'issueInvoices' THEN v_effective_role IN ('owner','manager','accountant')
        WHEN 'collectPayments' THEN v_effective_role IN ('owner','manager','accountant','collector')
        ELSE false
      END;
    END IF;

    -- Per-profile exceptions are applied after inherited or explicit permissions.
    SELECT capability_override.is_allowed INTO v_override
    FROM public.staff_profile_capability_overrides capability_override
    WHERE capability_override.tenant_id=target_tenant_id
      AND capability_override.profile_id=v_profile.id
      AND capability_override.capability=target_capability;
    IF FOUND THEN
      v_has_capability := v_override;
    END IF;
  END IF;

  IF NOT v_has_capability THEN
    RETURN false;
  END IF;

  -- Platform role policies are additional deny-only restrictions.
  IF EXISTS (
    SELECT 1 FROM public.platform_role_policies policy
    WHERE policy.role=v_effective_role
      AND policy.capability=target_capability
      AND policy.is_allowed=false
  ) THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$function$;


COMMENT ON FUNCTION private.powerhub_has_site_capability(bigint,bigint,text) IS
  'Caller-bound effective capability check for HR/payroll and financial read RLS; applies role/custom permissions, explicit permissions, profile/member overrides, platform deny policies, site assignment, active membership and suspension.';

REVOKE ALL ON FUNCTION private.powerhub_has_site_capability(bigint,bigint,text) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.powerhub_has_site_capability(bigint,bigint,text) TO authenticated, service_role;

DO $replace_financial_read_policies$
DECLARE
  target_table text;
  old_policy record;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'account_transactions','company_accounts','company_account_sites',
    'expenses','financial_settlements','invoices','payments','invoice_lines'
  ] LOOP
    FOR old_policy IN
      SELECT polname
      FROM pg_policy
      WHERE polrelid = to_regclass(format('public.%I',target_table))
        AND polcmd IN ('r','*')
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I',old_policy.polname,target_table);
    END LOOP;
  END LOOP;
END
$replace_financial_read_policies$;

CREATE POLICY account_transactions_financial_capability_read
ON public.account_transactions FOR SELECT TO authenticated
USING (
  private.powerhub_has_company_account_access(tenant_id,account_id)
  AND (
    private.powerhub_has_site_capability(tenant_id,site_id,'manageExpenses')
    OR private.powerhub_has_site_capability(tenant_id,site_id,'viewFinancialReports')
  )
);

CREATE POLICY company_accounts_financial_capability_read
ON public.company_accounts FOR SELECT TO authenticated
USING (
  private.powerhub_has_company_account_access(tenant_id,id)
  AND (
    EXISTS (
      SELECT 1 FROM public.company_account_sites mapping
      WHERE mapping.tenant_id=company_accounts.tenant_id
        AND mapping.account_id=company_accounts.id
        AND (
          private.powerhub_has_site_capability(mapping.tenant_id,mapping.site_id,'manageExpenses')
          OR private.powerhub_has_site_capability(mapping.tenant_id,mapping.site_id,'viewFinancialReports')
        )
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM public.company_account_sites mapping
        WHERE mapping.tenant_id=company_accounts.tenant_id
          AND mapping.account_id=company_accounts.id
      )
      AND (
        private.powerhub_has_site_capability(company_accounts.tenant_id,NULL,'manageExpenses')
        OR private.powerhub_has_site_capability(company_accounts.tenant_id,NULL,'viewFinancialReports')
        OR EXISTS (
          SELECT 1 FROM public.sites site
          WHERE site.tenant_id=company_accounts.tenant_id
            AND (
              private.powerhub_has_site_capability(site.tenant_id,site.id,'manageExpenses')
              OR private.powerhub_has_site_capability(site.tenant_id,site.id,'viewFinancialReports')
            )
        )
      )
    )
  )
);

CREATE POLICY company_account_sites_financial_capability_read
ON public.company_account_sites FOR SELECT TO authenticated
USING (
  private.powerhub_has_site_access(tenant_id,site_id)
  AND (
    private.powerhub_has_site_capability(tenant_id,site_id,'manageExpenses')
    OR private.powerhub_has_site_capability(tenant_id,site_id,'viewFinancialReports')
  )
);

CREATE POLICY expenses_financial_capability_read
ON public.expenses FOR SELECT TO authenticated
USING (
  private.powerhub_has_site_capability(tenant_id,site_id,'manageExpenses')
  OR private.powerhub_has_site_capability(tenant_id,site_id,'viewFinancialReports')
);

CREATE POLICY financial_settlements_financial_capability_read
ON public.financial_settlements FOR SELECT TO authenticated
USING (
  private.powerhub_has_site_capability(tenant_id,site_id,'manageExpenses')
  OR private.powerhub_has_site_capability(tenant_id,site_id,'viewFinancialReports')
);

CREATE POLICY invoices_financial_capability_read
ON public.invoices FOR SELECT TO authenticated
USING (
  private.powerhub_has_site_capability(tenant_id,site_id,'issueInvoices')
  OR private.powerhub_has_site_capability(tenant_id,site_id,'collectPayments')
  OR private.powerhub_has_site_capability(tenant_id,site_id,'viewFinancialReports')
);

CREATE POLICY payments_financial_capability_read
ON public.payments FOR SELECT TO authenticated
USING (
  private.powerhub_has_site_capability(tenant_id,site_id,'collectPayments')
  OR private.powerhub_has_site_capability(tenant_id,site_id,'viewFinancialReports')
);

CREATE POLICY invoice_lines_financial_capability_read
ON public.invoice_lines FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.invoices parent
    WHERE parent.tenant_id=invoice_lines.tenant_id
      AND parent.id=invoice_lines.invoice_id
      AND (
        private.powerhub_has_site_capability(parent.tenant_id,parent.site_id,'issueInvoices')
        OR private.powerhub_has_site_capability(parent.tenant_id,parent.site_id,'collectPayments')
        OR private.powerhub_has_site_capability(parent.tenant_id,parent.site_id,'viewFinancialReports')
      )
  )
);

NOTIFY pgrst, 'reload schema';
