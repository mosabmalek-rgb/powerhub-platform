-- Supplier catalogs, purchase documents and payables are consumed through scoped
-- server routes. Direct PostgREST SELECT bypasses their finer-grained capability
-- checks (viewSuppliers, viewPurchases, viewSupplierLedger, manageSupplierPayments).
-- Keep the existing tenant/site RLS policies as defense in depth and preserve the
-- service-role path used by the server RPC layer.

DO $preflight$
DECLARE
  target text;
  target_oid oid;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'suppliers',
    'supplier_purchases',
    'supplier_purchase_lines',
    'supplier_purchase_receipts',
    'supplier_purchase_receipt_lines',
    'supplier_payments',
    'supplier_payment_allocations',
    'supplier_ledger_entries',
    'supplier_purchase_returns',
    'supplier_purchase_return_lines'
  ] LOOP
    target_oid := to_regclass(format('public.%I', target));
    IF target_oid IS NULL THEN
      RAISE EXCEPTION 'SUPPLIER_SERVER_ONLY_TABLE_MISSING: %', target;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class relation
      WHERE relation.oid=target_oid
        AND relation.relrowsecurity=true
    ) THEN
      RAISE EXCEPTION 'SUPPLIER_SERVER_ONLY_RLS_DISABLED: %', target;
    END IF;

    IF NOT has_table_privilege('service_role', target_oid, 'SELECT') THEN
      RAISE EXCEPTION 'SUPPLIER_SERVER_ONLY_SERVICE_READ_MISSING: %', target;
    END IF;
  END LOOP;
END
$preflight$;

DO $revoke_browser_access$
DECLARE
  target text;
  target_oid oid;
  column_name text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'suppliers',
    'supplier_purchases',
    'supplier_purchase_lines',
    'supplier_purchase_receipts',
    'supplier_purchase_receipt_lines',
    'supplier_payments',
    'supplier_payment_allocations',
    'supplier_ledger_entries',
    'supplier_purchase_returns',
    'supplier_purchase_return_lines'
  ] LOOP
    target_oid := to_regclass(format('public.%I', target));

    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',
      target
    );

    -- Table-level REVOKE does not remove column-level grants. Revoke those
    -- explicitly as well so an old per-column SELECT cannot reopen PostgREST.
    FOR column_name IN
      SELECT attribute.attname
      FROM pg_attribute attribute
      WHERE attribute.attrelid=target_oid
        AND attribute.attnum>0
        AND NOT attribute.attisdropped
    LOOP
      EXECUTE format(
        'REVOKE SELECT (%I) ON TABLE public.%I FROM PUBLIC, anon, authenticated',
        column_name,
        target
      );
    END LOOP;

    IF has_table_privilege('anon', target_oid, 'SELECT')
       OR has_any_column_privilege('anon', target_oid, 'SELECT')
       OR has_table_privilege('authenticated', target_oid, 'SELECT')
       OR has_any_column_privilege('authenticated', target_oid, 'SELECT') THEN
      RAISE EXCEPTION 'SUPPLIER_BROWSER_READ_PRIVILEGE_REMAINS: %', target;
    END IF;

    IF NOT has_table_privilege('service_role', target_oid, 'SELECT') THEN
      RAISE EXCEPTION 'SUPPLIER_SERVER_READ_REVOKED: %', target;
    END IF;
  END LOOP;
END
$revoke_browser_access$;

NOTIFY pgrst, 'reload schema';
