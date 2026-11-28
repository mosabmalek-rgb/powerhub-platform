-- Give every company-account movement an authoritative branch scope.
-- Legacy rows are backfilled only from source records or audited RPC metadata; ambiguous rows stay NULL.
DO $preflight$
BEGIN
  IF to_regclass('public.account_transactions') IS NULL OR to_regclass('public.company_accounts') IS NULL
     OR to_regclass('public.company_account_sites') IS NULL OR to_regclass('public.sites') IS NULL
     OR to_regclass('public.payments') IS NULL OR to_regclass('public.expenses') IS NULL
     OR to_regclass('public.audit_logs') IS NULL
     OR to_regprocedure('private.powerhub_has_site_access(bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_TRANSACTION_SITE_SCOPE_PREREQUISITES_MISSING';
  END IF;
END
$preflight$;

ALTER TABLE public.account_transactions ADD COLUMN IF NOT EXISTS site_id bigint;
CREATE UNIQUE INDEX IF NOT EXISTS sites_tenant_id_id_scope_uidx ON public.sites(tenant_id,id);

DO $site_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.account_transactions'::regclass AND conname='account_transactions_tenant_site_scope_fk') THEN
    ALTER TABLE public.account_transactions
      ADD CONSTRAINT account_transactions_tenant_site_scope_fk
      FOREIGN KEY (tenant_id,site_id) REFERENCES public.sites(tenant_id,id) NOT VALID;
  END IF;
END
$site_fk$;

CREATE INDEX IF NOT EXISTS account_transactions_tenant_site_account_history_idx
  ON public.account_transactions(tenant_id,site_id,account_id,occurred_at DESC,id DESC)
  WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_transactions_tenant_site_account_created_idx
  ON public.account_transactions(tenant_id,site_id,account_id,created_at DESC,id DESC)
  WHERE site_id IS NOT NULL;

-- Suppress row-by-row Delta publication during historical backfill; the following
-- migration republishes each account once after its branch projections are corrected.
DO $disable_delta$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.account_transactions'::regclass
             AND tgname='powerhub_delta_sync_account_transactions' AND NOT tgisinternal) THEN
    ALTER TABLE public.account_transactions DISABLE TRIGGER powerhub_delta_sync_account_transactions;
  END IF;
END
$disable_delta$;

WITH payroll_expense AS (
  SELECT tx.id AS transaction_id,min(e.id) AS expense_id
  FROM public.account_transactions tx
  JOIN public.expenses e ON e.tenant_id=tx.tenant_id AND e.reference_no=tx.reference_no AND e.category='payroll'
  WHERE tx.related_expense_id IS NULL AND tx.reference_no ~ '^PAYROLL-[0-9]+$'
  GROUP BY tx.id HAVING count(*)=1 AND count(DISTINCT e.site_id)=1
)
UPDATE public.account_transactions tx
SET related_expense_id=pe.expense_id
FROM payroll_expense pe
WHERE tx.id=pe.transaction_id AND tx.related_expense_id IS NULL;

WITH source_sites AS (
  SELECT tx.id AS transaction_id,p.site_id FROM public.account_transactions tx
    JOIN public.payments p ON p.tenant_id=tx.tenant_id AND p.id=tx.related_payment_id
    WHERE tx.related_payment_id IS NOT NULL
  UNION ALL
  SELECT tx.id,e.site_id FROM public.account_transactions tx
    JOIN public.expenses e ON e.tenant_id=tx.tenant_id AND e.id=tx.related_expense_id
    WHERE tx.related_expense_id IS NOT NULL
  UNION ALL
  SELECT tx.id,sp.site_id FROM public.account_transactions tx
    JOIN public.supplier_payments sp ON sp.tenant_id=tx.tenant_id AND sp.id=tx.related_supplier_payment_id
    WHERE tx.related_supplier_payment_id IS NOT NULL
  UNION ALL
  SELECT tx.id,sr.site_id FROM public.account_transactions tx
    JOIN public.supplier_purchase_returns sr ON sr.tenant_id=tx.tenant_id AND sr.id=tx.related_supplier_return_id
    WHERE tx.related_supplier_return_id IS NOT NULL
  UNION ALL
  SELECT tx.id,ea.site_id FROM public.account_transactions tx
    JOIN public.employee_adjustments ea ON ea.tenant_id=tx.tenant_id AND ea.disbursement_transaction_id=tx.id
  UNION ALL
  SELECT tx.id,er.site_id FROM public.account_transactions tx
    JOIN public.employee_adjustment_repayments er ON er.tenant_id=tx.tenant_id AND er.account_transaction_id=tx.id
  UNION ALL
  SELECT tx.id,e.site_id FROM public.account_transactions tx
    JOIN public.expenses e ON e.tenant_id=tx.tenant_id AND e.reference_no=tx.reference_no AND e.category='payroll'
    WHERE tx.reference_no ~ '^PAYROLL-[0-9]+$'
  UNION ALL
  SELECT tx.id,sp.site_id FROM public.account_transactions tx
    JOIN public.supplier_payments sp ON sp.tenant_id=tx.tenant_id
      AND sp.id=substring(tx.reference_no from '([0-9]+)$')::bigint
    WHERE tx.reference_no ~ '^REV-SUPPLIER-PAYMENT-[0-9]+$'
  UNION ALL
  SELECT tx.id,al.site_id FROM public.account_transactions tx
    JOIN public.audit_logs al ON al.tenant_id=tx.tenant_id
    WHERE al.site_id IS NOT NULL AND (
      al.after_data->>'transactionId'=tx.id::text
      OR al.after_data->>'fromTransactionId'=tx.id::text
      OR al.after_data->>'toTransactionId'=tx.id::text
      OR al.after_data->>'accountTransactionId'=tx.id::text
    )
), resolved_sites AS (
  SELECT transaction_id,count(DISTINCT site_id) AS site_count,min(site_id) AS site_id
  FROM source_sites WHERE site_id IS NOT NULL GROUP BY transaction_id
)
UPDATE public.account_transactions tx
SET site_id=resolved.site_id
FROM resolved_sites resolved
WHERE tx.id=resolved.transaction_id AND tx.site_id IS NULL AND resolved.site_count=1;

DO $enable_delta$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.account_transactions'::regclass
             AND tgname='powerhub_delta_sync_account_transactions' AND NOT tgisinternal) THEN
    ALTER TABLE public.account_transactions ENABLE TRIGGER powerhub_delta_sync_account_transactions;
  END IF;
END
$enable_delta$;
ALTER TABLE public.account_transactions VALIDATE CONSTRAINT account_transactions_tenant_site_scope_fk;

CREATE OR REPLACE FUNCTION public.powerhub_set_account_transaction_site_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  v_source_count integer:=0;
  v_source_site_id bigint;
  v_payroll_count integer:=0;
  v_payroll_expense_id bigint;
  v_payroll_site_id bigint;
BEGIN
  IF NEW.related_expense_id IS NULL AND NEW.reference_no ~ '^PAYROLL-[0-9]+$' THEN
    SELECT count(*)::integer,min(e.id),min(e.site_id)
      INTO v_payroll_count,v_payroll_expense_id,v_payroll_site_id
    FROM public.expenses e
    WHERE e.tenant_id=NEW.tenant_id AND e.reference_no=NEW.reference_no AND e.category='payroll';
    IF v_payroll_count=1 THEN
      NEW.related_expense_id:=v_payroll_expense_id;
      IF NEW.site_id IS NULL THEN NEW.site_id:=v_payroll_site_id; END IF;
    END IF;
  END IF;

  SELECT count(DISTINCT candidate.site_id)::integer,min(candidate.site_id)
    INTO v_source_count,v_source_site_id
  FROM (
    SELECT p.site_id FROM public.payments p
      WHERE NEW.related_payment_id IS NOT NULL AND p.tenant_id=NEW.tenant_id AND p.id=NEW.related_payment_id
    UNION ALL
    SELECT e.site_id FROM public.expenses e
      WHERE NEW.related_expense_id IS NOT NULL AND e.tenant_id=NEW.tenant_id AND e.id=NEW.related_expense_id
    UNION ALL
    SELECT sp.site_id FROM public.supplier_payments sp
      WHERE NEW.related_supplier_payment_id IS NOT NULL AND sp.tenant_id=NEW.tenant_id AND sp.id=NEW.related_supplier_payment_id
    UNION ALL
    SELECT sr.site_id FROM public.supplier_purchase_returns sr
      WHERE NEW.related_supplier_return_id IS NOT NULL AND sr.tenant_id=NEW.tenant_id AND sr.id=NEW.related_supplier_return_id
    UNION ALL
    SELECT ea.site_id FROM public.employee_adjustments ea
      WHERE ea.tenant_id=NEW.tenant_id AND ea.disbursement_transaction_id=NEW.id
    UNION ALL
    SELECT er.site_id FROM public.employee_adjustment_repayments er
      WHERE er.tenant_id=NEW.tenant_id AND er.account_transaction_id=NEW.id
    UNION ALL
    SELECT sp.site_id FROM public.supplier_payments sp
      WHERE NEW.reference_no ~ '^REV-SUPPLIER-PAYMENT-[0-9]+$'
        AND sp.tenant_id=NEW.tenant_id
        AND sp.id=substring(NEW.reference_no from '([0-9]+)$')::bigint
  ) candidate
  WHERE candidate.site_id IS NOT NULL;

  IF v_source_count>1 THEN RAISE EXCEPTION 'ACCOUNT_TRANSACTION_SOURCE_SITE_AMBIGUOUS' USING ERRCODE='P0001'; END IF;
  IF NEW.site_id IS NULL AND v_source_count=1 THEN NEW.site_id:=v_source_site_id;
  ELSIF NEW.site_id IS NOT NULL AND v_source_count=1 AND NEW.site_id<>v_source_site_id THEN
    RAISE EXCEPTION 'ACCOUNT_TRANSACTION_SOURCE_SITE_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF NEW.site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sites s WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.site_id
  ) THEN RAISE EXCEPTION 'ACCOUNT_TRANSACTION_SITE_OUT_OF_SCOPE' USING ERRCODE='P0001'; END IF;
  IF NEW.site_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.company_account_sites cas WHERE cas.tenant_id=NEW.tenant_id AND cas.account_id=NEW.account_id)
     AND NOT EXISTS (SELECT 1 FROM public.company_account_sites cas WHERE cas.tenant_id=NEW.tenant_id AND cas.account_id=NEW.account_id AND cas.site_id=NEW.site_id) THEN
    RAISE EXCEPTION 'ACCOUNT_TRANSACTION_ACCOUNT_SITE_MISMATCH' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_apply_account_transaction_audit_site()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE v_transaction_id bigint;
BEGIN
  IF NEW.site_id IS NULL OR NEW.after_data IS NULL THEN RETURN NEW; END IF;
  FOREACH v_transaction_id IN ARRAY ARRAY[
    CASE WHEN NEW.after_data->>'transactionId' ~ '^[1-9][0-9]*$' THEN (NEW.after_data->>'transactionId')::bigint END,
    CASE WHEN NEW.after_data->>'fromTransactionId' ~ '^[1-9][0-9]*$' THEN (NEW.after_data->>'fromTransactionId')::bigint END,
    CASE WHEN NEW.after_data->>'toTransactionId' ~ '^[1-9][0-9]*$' THEN (NEW.after_data->>'toTransactionId')::bigint END,
    CASE WHEN NEW.after_data->>'accountTransactionId' ~ '^[1-9][0-9]*$' THEN (NEW.after_data->>'accountTransactionId')::bigint END
  ] LOOP
    IF v_transaction_id IS NULL THEN CONTINUE; END IF;
    UPDATE public.account_transactions tx SET site_id=NEW.site_id
    WHERE tx.tenant_id=NEW.tenant_id AND tx.id=v_transaction_id AND tx.site_id IS NULL;
    IF EXISTS (SELECT 1 FROM public.account_transactions tx
      WHERE tx.tenant_id=NEW.tenant_id AND tx.id=v_transaction_id
        AND tx.site_id IS NOT NULL AND tx.site_id<>NEW.site_id) THEN
      RAISE EXCEPTION 'ACCOUNT_TRANSACTION_AUDIT_SITE_MISMATCH' USING ERRCODE='P0001';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_assert_account_transaction_site()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE v_site_id bigint;
BEGIN
  SELECT tx.site_id INTO v_site_id FROM public.account_transactions tx
  WHERE tx.tenant_id=NEW.tenant_id AND tx.id=NEW.id;
  IF v_site_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_TRANSACTION_SITE_REQUIRED' USING ERRCODE='P0001'; END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS account_transactions_resolve_site_before_write ON public.account_transactions;
CREATE TRIGGER account_transactions_resolve_site_before_write
BEFORE INSERT OR UPDATE OF site_id,related_payment_id,related_expense_id,related_supplier_payment_id,related_supplier_return_id,reference_no
ON public.account_transactions FOR EACH ROW
EXECUTE FUNCTION public.powerhub_set_account_transaction_site_scope();

DROP TRIGGER IF EXISTS account_transactions_site_required_deferred ON public.account_transactions;
CREATE CONSTRAINT TRIGGER account_transactions_site_required_deferred
AFTER INSERT ON public.account_transactions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.powerhub_assert_account_transaction_site();

DROP TRIGGER IF EXISTS audit_logs_scope_account_transactions ON public.audit_logs;
CREATE TRIGGER audit_logs_scope_account_transactions
AFTER INSERT OR UPDATE OF site_id,after_data ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.powerhub_apply_account_transaction_audit_site();

DROP POLICY IF EXISTS account_transactions_site_scope_read ON public.account_transactions;
CREATE POLICY account_transactions_site_scope_read
ON public.account_transactions FOR SELECT TO authenticated
USING (private.powerhub_has_site_access(tenant_id,site_id));

REVOKE ALL ON FUNCTION public.powerhub_set_account_transaction_site_scope() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_apply_account_transaction_audit_site() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.powerhub_assert_account_transaction_site() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_set_account_transaction_site_scope() TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_apply_account_transaction_audit_site() TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_assert_account_transaction_site() TO service_role;

NOTIFY pgrst,'reload schema';
