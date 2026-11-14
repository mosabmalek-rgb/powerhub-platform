-- Re-run the account/site scope resolver when an account movement changes
-- its account_id. The resolver already validates the account's mapped sites;
-- the trigger column list must invoke it for this mutation as well.
DO $preflight$
BEGIN
  IF to_regprocedure('public.powerhub_set_account_transaction_site_scope()') IS NULL
     OR to_regclass('public.account_transactions') IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_TRANSACTION_ACCOUNT_SCOPE_PREREQUISITES_MISSING';
  END IF;
END
$preflight$;

DROP TRIGGER IF EXISTS account_transactions_resolve_site_before_write
  ON public.account_transactions;

CREATE TRIGGER account_transactions_resolve_site_before_write
BEFORE INSERT OR UPDATE OF
  account_id,
  site_id,
  related_payment_id,
  related_expense_id,
  related_supplier_payment_id,
  related_supplier_return_id,
  reference_no
ON public.account_transactions
FOR EACH ROW
EXECUTE FUNCTION public.powerhub_set_account_transaction_site_scope();

DO $assert_trigger$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_triggerdef(t.oid)
  INTO v_definition
  FROM pg_trigger t
  WHERE t.tgrelid='public.account_transactions'::regclass
    AND t.tgname='account_transactions_resolve_site_before_write'
    AND NOT t.tgisinternal;

  IF v_definition IS NULL OR v_definition NOT ILIKE '%account_id%' THEN
    RAISE EXCEPTION 'ACCOUNT_TRANSACTION_ACCOUNT_ID_SCOPE_TRIGGER_MISSING';
  END IF;
END
$assert_trigger$;

NOTIFY pgrst,'reload schema';
