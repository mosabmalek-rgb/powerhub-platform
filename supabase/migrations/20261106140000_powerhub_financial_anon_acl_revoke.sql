-- These financial relations are readable only by signed-in tenant/site users.
-- RLS policies are explicitly scoped to authenticated and the application already
-- obtains public-payment/documentation views through server-only RPCs.
DO $financial_anon_acl_preflight$
DECLARE
  v_name text;
  v_table regclass;
  v_anon_oid oid := (SELECT oid FROM pg_roles WHERE rolname='anon');
  v_authenticated_oid oid := (SELECT oid FROM pg_roles WHERE rolname='authenticated');
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'account_transactions',
    'company_account_sites',
    'company_accounts',
    'expenses',
    'financial_settlements',
    'invoice_lines',
    'invoices',
    'payments'
  ] LOOP
    v_table := to_regclass('public.'||v_name);
    IF v_table IS NULL THEN
      RAISE EXCEPTION 'FINANCIAL_ANON_ACL_TABLE_MISSING: %',v_name;
    END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=v_table) THEN
      RAISE EXCEPTION 'FINANCIAL_ANON_ACL_RLS_DISABLED: %',v_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid=v_table
        AND p.polcmd IN ('r','*')
        AND v_authenticated_oid=ANY(p.polroles)
    ) THEN
      RAISE EXCEPTION 'FINANCIAL_AUTHENTICATED_READ_POLICY_MISSING: %',v_name;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid=v_table
        AND (0=ANY(p.polroles) OR v_anon_oid=ANY(p.polroles))
    ) THEN
      RAISE EXCEPTION 'FINANCIAL_ANONYMOUS_POLICY_PRESENT_REQUIRES_REVIEW: %',v_name;
    END IF;
  END LOOP;
END
$financial_anon_acl_preflight$;

REVOKE ALL PRIVILEGES ON TABLE
  public.account_transactions,
  public.company_account_sites,
  public.company_accounts,
  public.expenses,
  public.financial_settlements,
  public.invoice_lines,
  public.invoices,
  public.payments
FROM PUBLIC, anon;

DO $financial_anon_acl_postflight$
DECLARE
  v_name text;
  v_table regclass;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'account_transactions',
    'company_account_sites',
    'company_accounts',
    'expenses',
    'financial_settlements',
    'invoice_lines',
    'invoices',
    'payments'
  ] LOOP
    v_table := to_regclass('public.'||v_name);

    IF has_table_privilege('anon',v_table,'SELECT')
       OR has_table_privilege('anon',v_table,'INSERT')
       OR has_table_privilege('anon',v_table,'UPDATE')
       OR has_table_privilege('anon',v_table,'DELETE')
       OR has_table_privilege('anon',v_table,'REFERENCES')
       OR has_table_privilege('anon',v_table,'TRIGGER')
       OR has_table_privilege('anon',v_table,'TRUNCATE') THEN
      RAISE EXCEPTION 'FINANCIAL_ANON_TABLE_PRIVILEGE_REMAINS: %',v_name;
    END IF;

    IF NOT has_table_privilege('authenticated',v_table,'SELECT')
       OR has_table_privilege('authenticated',v_table,'INSERT')
       OR has_table_privilege('authenticated',v_table,'UPDATE')
       OR has_table_privilege('authenticated',v_table,'DELETE') THEN
      RAISE EXCEPTION 'FINANCIAL_AUTHENTICATED_READ_CONTRACT_CHANGED: %',v_name;
    END IF;

    IF NOT has_table_privilege('service_role',v_table,'SELECT')
       OR NOT has_table_privilege('service_role',v_table,'INSERT')
       OR NOT has_table_privilege('service_role',v_table,'UPDATE')
       OR NOT has_table_privilege('service_role',v_table,'DELETE') THEN
      RAISE EXCEPTION 'FINANCIAL_SERVICE_ROLE_ACCESS_CHANGED: %',v_name;
    END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=v_table)
       OR NOT EXISTS (
         SELECT 1 FROM pg_policy p
         WHERE p.polrelid=v_table
           AND p.polcmd IN ('r','*')
           AND (SELECT oid FROM pg_roles WHERE rolname='authenticated')=ANY(p.polroles)
       ) THEN
      RAISE EXCEPTION 'FINANCIAL_RLS_POLICY_CHANGED: %',v_name;
    END IF;
  END LOOP;
END
$financial_anon_acl_postflight$;
