\set ON_ERROR_STOP on

-- Start from the full, disposable ledger-derived settlement fixture.
\ir financial_settlement_ledger_derived.sql

-- The legacy account-movement RPC omits site_id. Reproduce the production
-- BEFORE INSERT site resolver in this isolated fixture.
ALTER TABLE public.account_transactions ALTER COLUMN site_id DROP NOT NULL;
-- Keep the real company-account RPC compatible with the compact ledger fixture.
-- These fields exist in the production account_transactions schema and are read
-- or populated by powerhub_add_account_movement.
ALTER TABLE public.account_transactions
  ADD COLUMN description text NOT NULL DEFAULT '',
  ADD COLUMN reference_no text,
  ADD COLUMN created_by_user_id bigint;
ALTER TABLE public.account_transactions
  ALTER COLUMN occurred_at SET DEFAULT now();
CREATE SEQUENCE public.financial_settlement_concurrency_tx_id_seq START WITH 90000;
ALTER TABLE public.account_transactions
  ALTER COLUMN id SET DEFAULT nextval('public.financial_settlement_concurrency_tx_id_seq');
ALTER SEQUENCE public.financial_settlement_concurrency_tx_id_seq
  OWNED BY public.account_transactions.id;

CREATE OR REPLACE FUNCTION public.financial_settlement_test_resolve_account_transaction_site()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.site_id IS NULL THEN
    SELECT min(cas.site_id) INTO NEW.site_id
    FROM public.company_account_sites cas
    WHERE cas.tenant_id = NEW.tenant_id AND cas.account_id = NEW.account_id;
  END IF;
  IF NEW.site_id IS NULL THEN RAISE EXCEPTION 'TEST_ACCOUNT_SITE_NOT_FOUND'; END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER aaa_test_resolve_account_transaction_site
BEFORE INSERT ON public.account_transactions
FOR EACH ROW EXECUTE FUNCTION public.financial_settlement_test_resolve_account_transaction_site();

-- Install the real legacy RPC, not a mock writer.
\ir ../migrations/0016_powerhub_company_account_mutations.sql

-- Add a cash account scoped only to site 11 for a second, independent case.
INSERT INTO public.company_accounts(id,tenant_id,opening_balance,created_at)
VALUES (103,1,0,statement_timestamp());
INSERT INTO public.company_account_sites(tenant_id,account_id,site_id)
VALUES (1,103,11);

CREATE TABLE public.financial_settlement_concurrency_test_state(
  site_id bigint PRIMARY KEY,
  settlement_id bigint NOT NULL
);
GRANT SELECT,INSERT,UPDATE,DELETE
  ON public.financial_settlement_concurrency_test_state TO service_role;

SET ROLE service_role;
DO $setup$
DECLARE
  v_period_start timestamptz := date_trunc('month',statement_timestamp());
  v_period_end timestamptz := date_trunc('month',statement_timestamp())
    + interval '1 month' - interval '1 microsecond';
  v_site_id bigint;
  v_settlement_id bigint;
BEGIN
  FOREACH v_site_id IN ARRAY ARRAY[10,11]::bigint[] LOOP
    SELECT c.settlement_id INTO v_settlement_id
    FROM public.powerhub_create_financial_settlement(
      1,v_site_id,1,v_period_start,v_period_end,NULL,
      'Automated concurrent source-write fixture'
    ) AS c;
    PERFORM * FROM public.powerhub_set_financial_settlement_status(
      1,v_site_id,1,v_settlement_id,'submitted');
    PERFORM * FROM public.powerhub_set_financial_settlement_status(
      1,v_site_id,2,v_settlement_id,'approved');
    INSERT INTO public.financial_settlement_concurrency_test_state(site_id,settlement_id)
    VALUES (v_site_id,v_settlement_id);
  END LOOP;
END
$setup$;
RESET ROLE;

SELECT 'FINANCIAL_SETTLEMENT_CONCURRENCY_FIXTURE_READY' AS result;