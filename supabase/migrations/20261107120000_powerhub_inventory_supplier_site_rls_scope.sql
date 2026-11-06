-- Restrict direct authenticated reads of branch-bound supplier and purchasing
-- records. Tenant-wide catalogs (items and suppliers) intentionally stay tenant-wide.
-- All operational API reads continue through server-side handlers and scoped RPCs.
DO $preflight$
DECLARE
  target record;
BEGIN
  IF to_regprocedure('private.powerhub_has_site_access(bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_SUPPLIER_SITE_SCOPE_HELPER_MISSING';
  END IF;

  FOR target IN
    SELECT * FROM (VALUES
      ('supplier_purchases', ARRAY['tenant_id','site_id']::text[]),
      ('supplier_purchase_lines', ARRAY['tenant_id','purchase_id']::text[]),
      ('supplier_purchase_receipts', ARRAY['tenant_id','site_id']::text[]),
      ('supplier_purchase_receipt_lines', ARRAY['tenant_id','receipt_id','purchase_id']::text[]),
      ('supplier_purchase_returns', ARRAY['tenant_id','site_id']::text[]),
      ('supplier_purchase_return_lines', ARRAY['tenant_id','return_id','purchase_id']::text[]),
      ('supplier_payments', ARRAY['tenant_id','site_id']::text[]),
      ('supplier_payment_allocations', ARRAY['tenant_id','payment_id','purchase_id']::text[]),
      ('supplier_ledger_entries', ARRAY['tenant_id','site_id']::text[])
    ) AS scoped(table_name, required_columns)
  LOOP
    IF to_regclass(format('public.%I', target.table_name)) IS NULL THEN
      RAISE EXCEPTION 'INVENTORY_SUPPLIER_SITE_SCOPE_TABLE_MISSING: %', target.table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid=to_regclass(format('public.%I',target.table_name)) AND relrowsecurity
    ) THEN
      RAISE EXCEPTION 'INVENTORY_SUPPLIER_SITE_SCOPE_RLS_DISABLED: %', target.table_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM unnest(target.required_columns) required_column
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid=to_regclass(format('public.%I',target.table_name))
          AND a.attname=required_column AND a.attnum>0 AND NOT a.attisdropped
      )
    ) THEN
      RAISE EXCEPTION 'INVENTORY_SUPPLIER_SITE_SCOPE_COLUMN_MISSING: %', target.table_name;
    END IF;
  END LOOP;
END
$preflight$;

-- Headers carry site_id directly.
DO $headers$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'supplier_purchases',
    'supplier_purchase_receipts',
    'supplier_purchase_returns',
    'supplier_payments',
    'supplier_ledger_entries'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_site_scope_read_guard', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (private.powerhub_has_site_access(tenant_id,site_id))',
      target || '_site_scope_read_guard', target
    );
  END LOOP;
END
$headers$;

-- Detail rows inherit visibility from their owning branch header. Allocations
-- must be attached to a payment and purchase in the same visible branch.
DROP POLICY IF EXISTS supplier_purchase_lines_site_scope_read_guard ON public.supplier_purchase_lines;
CREATE POLICY supplier_purchase_lines_site_scope_read_guard
  ON public.supplier_purchase_lines AS RESTRICTIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.supplier_purchases parent
    WHERE parent.tenant_id=supplier_purchase_lines.tenant_id
      AND parent.id=supplier_purchase_lines.purchase_id
      AND private.powerhub_has_site_access(parent.tenant_id,parent.site_id)
  ));

DROP POLICY IF EXISTS supplier_purchase_receipt_lines_site_scope_read_guard ON public.supplier_purchase_receipt_lines;
CREATE POLICY supplier_purchase_receipt_lines_site_scope_read_guard
  ON public.supplier_purchase_receipt_lines AS RESTRICTIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.supplier_purchase_receipts receipt
    JOIN public.supplier_purchases purchase
      ON purchase.tenant_id=receipt.tenant_id AND purchase.id=receipt.purchase_id
    WHERE receipt.tenant_id=supplier_purchase_receipt_lines.tenant_id
      AND receipt.id=supplier_purchase_receipt_lines.receipt_id
      AND purchase.id=supplier_purchase_receipt_lines.purchase_id
      AND receipt.site_id=purchase.site_id
      AND private.powerhub_has_site_access(receipt.tenant_id,receipt.site_id)
  ));

DROP POLICY IF EXISTS supplier_purchase_return_lines_site_scope_read_guard ON public.supplier_purchase_return_lines;
CREATE POLICY supplier_purchase_return_lines_site_scope_read_guard
  ON public.supplier_purchase_return_lines AS RESTRICTIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.supplier_purchase_returns returned
    JOIN public.supplier_purchases purchase
      ON purchase.tenant_id=returned.tenant_id AND purchase.id=returned.purchase_id
    WHERE returned.tenant_id=supplier_purchase_return_lines.tenant_id
      AND returned.id=supplier_purchase_return_lines.return_id
      AND purchase.id=supplier_purchase_return_lines.purchase_id
      AND returned.site_id=purchase.site_id
      AND private.powerhub_has_site_access(returned.tenant_id,returned.site_id)
  ));

DROP POLICY IF EXISTS supplier_payment_allocations_site_scope_read_guard ON public.supplier_payment_allocations;
CREATE POLICY supplier_payment_allocations_site_scope_read_guard
  ON public.supplier_payment_allocations AS RESTRICTIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.supplier_payments payment
    JOIN public.supplier_purchases purchase
      ON purchase.tenant_id=payment.tenant_id
    JOIN public.supplier_payment_allocations allocation
      ON allocation.tenant_id=payment.tenant_id
     AND allocation.payment_id=payment.id
     AND allocation.purchase_id=purchase.id
    WHERE allocation.id=supplier_payment_allocations.id
      AND payment.site_id=purchase.site_id
      AND private.powerhub_has_site_access(payment.tenant_id,payment.site_id)
  ));

DO $assertions$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'supplier_purchases','supplier_purchase_lines',
    'supplier_purchase_receipts','supplier_purchase_receipt_lines',
    'supplier_purchase_returns','supplier_purchase_return_lines',
    'supplier_payments','supplier_payment_allocations','supplier_ledger_entries'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename=target
        AND policyname=target || '_site_scope_read_guard'
        AND roles=ARRAY['authenticated']::name[]
        AND cmd='SELECT' AND permissive='RESTRICTIVE'
        AND coalesce(qual,'') ILIKE '%powerhub_has_site_access%'
    ) THEN
      RAISE EXCEPTION 'INVENTORY_SUPPLIER_SITE_SCOPE_POLICY_ASSERTION_FAILED: %',target;
    END IF;
    IF NOT has_table_privilege('authenticated',format('public.%I',target),'SELECT') THEN
      RAISE EXCEPTION 'INVENTORY_SUPPLIER_SITE_SCOPE_SELECT_GRANT_MISSING: %',target;
    END IF;
  END LOOP;
END
$assertions$;

NOTIFY pgrst,'reload schema';
