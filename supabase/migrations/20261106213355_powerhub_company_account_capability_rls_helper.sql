-- Keep company-account read policy scoped without requiring direct SELECT on sites.
-- This SECURITY DEFINER predicate reads only a boolean and binds every check to auth.uid().
CREATE OR REPLACE FUNCTION private.powerhub_has_company_account_capability(
  p_tenant_id bigint,
  p_account_id bigint,
  p_capability text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $function$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.company_account_sites mapping
      WHERE mapping.tenant_id=p_tenant_id AND mapping.account_id=p_account_id
    ) THEN EXISTS (
      SELECT 1 FROM public.company_account_sites mapping
      WHERE mapping.tenant_id=p_tenant_id AND mapping.account_id=p_account_id
        AND private.powerhub_has_site_capability(mapping.tenant_id,mapping.site_id,p_capability)
    )
    ELSE EXISTS (
      SELECT 1 FROM public.sites site
      WHERE site.tenant_id=p_tenant_id
        AND private.powerhub_has_site_access(site.tenant_id,site.id)
        AND private.powerhub_has_site_capability(site.tenant_id,site.id,p_capability)
    )
  END;
$function$;

REVOKE ALL ON FUNCTION private.powerhub_has_company_account_capability(bigint,bigint,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.powerhub_has_company_account_capability(bigint,bigint,text) TO authenticated, service_role;

DROP POLICY IF EXISTS company_accounts_financial_capability_read ON public.company_accounts;
CREATE POLICY company_accounts_financial_capability_read
ON public.company_accounts FOR SELECT TO authenticated
USING (
  private.powerhub_has_company_account_access(tenant_id,id)
  AND (
    private.powerhub_has_company_account_capability(tenant_id,id,'manageExpenses')
    OR private.powerhub_has_company_account_capability(tenant_id,id,'viewFinancialReports')
  )
);
NOTIFY pgrst, 'reload schema';
