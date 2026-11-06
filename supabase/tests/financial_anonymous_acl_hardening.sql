\set ON_ERROR_STOP on

DO $roles$
BEGIN
  BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE TABLE public.account_transactions(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);
CREATE TABLE public.company_account_sites(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);
CREATE TABLE public.company_accounts(id bigint PRIMARY KEY,tenant_id bigint NOT NULL);
CREATE TABLE public.expenses(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);
CREATE TABLE public.financial_settlements(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);
CREATE TABLE public.invoice_lines(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,invoice_id bigint NOT NULL);
CREATE TABLE public.invoices(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);
CREATE TABLE public.payments(id bigint PRIMARY KEY,tenant_id bigint NOT NULL,site_id bigint NOT NULL);

INSERT INTO public.account_transactions VALUES(1,10,100);
INSERT INTO public.company_account_sites VALUES(1,10,100);
INSERT INTO public.company_accounts VALUES(1,10);
INSERT INTO public.expenses VALUES(1,10,100);
INSERT INTO public.financial_settlements VALUES(1,10,100);
INSERT INTO public.invoice_lines VALUES(1,10,1);
INSERT INTO public.invoices VALUES(1,10,100);
INSERT INTO public.payments VALUES(1,10,100);

ALTER TABLE public.account_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_account_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_transactions_auth_read ON public.account_transactions FOR SELECT TO authenticated USING (true);
CREATE POLICY company_account_sites_auth_read ON public.company_account_sites FOR SELECT TO authenticated USING (true);
CREATE POLICY company_accounts_auth_read ON public.company_accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY expenses_auth_read ON public.expenses FOR SELECT TO authenticated USING (true);
CREATE POLICY financial_settlements_auth_read ON public.financial_settlements FOR SELECT TO authenticated USING (true);
CREATE POLICY invoice_lines_auth_read ON public.invoice_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY invoices_auth_read ON public.invoices FOR SELECT TO authenticated USING (true);
CREATE POLICY payments_auth_read ON public.payments FOR SELECT TO authenticated USING (true);

-- Simulate the excess direct SELECT/REFERENCES/TRIGGER/MAINTAIN grants.
GRANT SELECT, REFERENCES, TRIGGER, MAINTAIN ON TABLE
  public.account_transactions,public.company_account_sites,public.company_accounts,
  public.expenses,public.financial_settlements,public.invoice_lines,public.invoices,public.payments
TO anon,authenticated;
GRANT ALL PRIVILEGES ON TABLE
  public.account_transactions,public.company_account_sites,public.company_accounts,
  public.expenses,public.financial_settlements,public.invoice_lines,public.invoices,public.payments
TO service_role;

\ir ../migrations/20261106140000_powerhub_financial_anon_acl_revoke.sql

DO $assert_privileges$
DECLARE v_name text; v_table regclass;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'account_transactions','company_account_sites','company_accounts','expenses',
    'financial_settlements','invoice_lines','invoices','payments'
  ] LOOP
    v_table:=to_regclass('public.'||v_name);
    IF has_table_privilege('anon',v_table,'SELECT')
       OR has_table_privilege('anon',v_table,'INSERT')
       OR has_table_privilege('anon',v_table,'UPDATE')
       OR has_table_privilege('anon',v_table,'DELETE')
       OR has_table_privilege('anon',v_table,'REFERENCES')
       OR has_table_privilege('anon',v_table,'TRIGGER')
       OR has_table_privilege('anon',v_table,'MAINTAIN') THEN
      RAISE EXCEPTION 'ANON_FINANCIAL_PRIVILEGE_REMAINS: %',v_name;
    END IF;
    IF NOT has_table_privilege('authenticated',v_table,'SELECT')
       OR has_table_privilege('authenticated',v_table,'INSERT')
       OR has_table_privilege('authenticated',v_table,'UPDATE')
       OR has_table_privilege('authenticated',v_table,'DELETE') THEN
      RAISE EXCEPTION 'AUTHENTICATED_FINANCIAL_READ_CHANGED: %',v_name;
    END IF;
    IF NOT has_table_privilege('service_role',v_table,'SELECT')
       OR NOT has_table_privilege('service_role',v_table,'INSERT')
       OR NOT has_table_privilege('service_role',v_table,'UPDATE')
       OR NOT has_table_privilege('service_role',v_table,'DELETE') THEN
      RAISE EXCEPTION 'SERVICE_ROLE_FINANCIAL_ACCESS_CHANGED: %',v_name;
    END IF;
  END LOOP;
END
$assert_privileges$;

SET ROLE authenticated;
DO $authenticated_reads$
BEGIN
  IF (SELECT count(*) FROM public.account_transactions)<>1
     OR (SELECT count(*) FROM public.company_account_sites)<>1
     OR (SELECT count(*) FROM public.company_accounts)<>1
     OR (SELECT count(*) FROM public.expenses)<>1
     OR (SELECT count(*) FROM public.financial_settlements)<>1
     OR (SELECT count(*) FROM public.invoice_lines)<>1
     OR (SELECT count(*) FROM public.invoices)<>1
     OR (SELECT count(*) FROM public.payments)<>1 THEN
    RAISE EXCEPTION 'AUTHENTICATED_FINANCIAL_SELECT_WAS_BROKEN';
  END IF;
END
$authenticated_reads$;
RESET ROLE;

SET ROLE anon;
DO $anonymous_reads$
DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'account_transactions','company_account_sites','company_accounts','expenses',
    'financial_settlements','invoice_lines','invoices','payments'
  ] LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM public.%I LIMIT 1',v_name);
      RAISE EXCEPTION 'ANONYMOUS_FINANCIAL_READ_ALLOWED: %',v_name;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END LOOP;
END
$anonymous_reads$;
RESET ROLE;

SELECT 'financial anonymous ACL hardening passed; authenticated reads and service writes preserved' AS result;
