-- D5: classify inventory cost only while all affected accrual site/months are open.
-- This closes a proven C4 bypass: updating an item from spare_part/expense_on_issue
-- to other/capital_asset after a site/month accrual close could remove historical
-- consumption cost. Cash settlement locks alone do not protect accrual months.
-- Version-exact protected release ONLY; do not use unversioned apply_migration.
CREATE OR REPLACE FUNCTION public.powerhub_financial_d5_guard_inventory_item_classification()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $guard$
DECLARE
  v_scope record;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'D5_UNSUPPORTED_INVENTORY_ITEM_OPERATION' USING ERRCODE='22023';
  END IF;

  -- These fields drive monthly inventory-cost recognition. Name, description,
  -- reorder point and other descriptive writes remain independent.
  IF ROW(OLD.tenant_id,OLD.id,OLD.category,OLD.accounting_treatment)
     IS NOT DISTINCT FROM
     ROW(NEW.tenant_id,NEW.id,NEW.category,NEW.accounting_treatment)
  THEN RETURN NEW; END IF;

  -- Existing tenant/item index allows a targeted lookup, not a scan of all
  -- inventory movements. Include old and new keys to prevent scope moves.
  -- Acquire every affected C4 advisory key in one deterministic order.
  FOR v_scope IN
    SELECT DISTINCT m.tenant_id,m.site_id,
      to_char((m.occurred_at AT TIME ZONE 'Asia/Gaza')::date,'YYYY-MM') AS period
    FROM public.inventory_stock_movements AS m
    WHERE (m.tenant_id=OLD.tenant_id AND m.item_id=OLD.id)
       OR (m.tenant_id=NEW.tenant_id AND m.item_id=NEW.id)
    ORDER BY 1,2,3
  LOOP
    IF v_scope.tenant_id IS NULL OR v_scope.site_id IS NULL OR
       v_scope.period IS NULL THEN
      RAISE EXCEPTION 'D5_INVALID_INVENTORY_SOURCE_SCOPE' USING ERRCODE='22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'powerhub:accrual-period:'||v_scope.tenant_id::text||':'||
      v_scope.site_id::text||':'||v_scope.period,0));
    IF EXISTS (
      SELECT 1 FROM public.financial_accrual_period_reviews AS r
      WHERE r.tenant_id=v_scope.tenant_id AND r.site_id=v_scope.site_id
        AND r.period=v_scope.period AND r.status='locked'
    ) THEN
      RAISE EXCEPTION 'D5_INVENTORY_CLASSIFICATION_ACCRUAL_PERIOD_LOCKED'
        USING ERRCODE='22023';
    END IF;
  END LOOP;
  RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION public.powerhub_financial_d5_guard_inventory_item_classification()
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_d5_guard_inventory_item_classification()
 TO service_role;

DROP TRIGGER IF EXISTS d5_inventory_item_accrual_classification_guard
 ON public.inventory_items;
CREATE TRIGGER d5_inventory_item_accrual_classification_guard
BEFORE UPDATE OF tenant_id,id,category,accounting_treatment
ON public.inventory_items FOR EACH ROW
EXECUTE FUNCTION public.powerhub_financial_d5_guard_inventory_item_classification();

COMMENT ON FUNCTION public.powerhub_financial_d5_guard_inventory_item_classification()
IS 'Protects the C4 site-month accrual close against inventory item category/accounting treatment changes across all recorded movement months. Cash settlement guard remains separately enforced.';
NOTIFY pgrst, 'reload schema';
