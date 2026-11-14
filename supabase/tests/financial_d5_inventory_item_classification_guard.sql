-- D5 isolated PostgreSQL 17 regression. Executes actual C4/D3/D4 and D5
-- migration SQL on a disposable database; NEVER execute this setup on Staging.
\set ON_ERROR_STOP on
\ir financial_d4_source_guard_setup.sql

CREATE TABLE public.inventory_items (
 id bigint PRIMARY KEY, tenant_id bigint NOT NULL,
 category text NOT NULL, accounting_treatment text NOT NULL,
 notes text
);
INSERT INTO public.inventory_items(id,tenant_id,category,accounting_treatment,notes)
VALUES (7,901,'spare_part','expense_on_issue','closed June item'),
       (8,901,'spare_part','expense_on_issue','open July item'),
       (9,902,'spare_part','expense_on_issue','other tenant');

INSERT INTO public.inventory_stock_movements
 (id,tenant_id,site_id,item_id,warehouse_id,movement_type,quantity,
  unit_cost,total_cost_amount,occurred_at,operation_key)
VALUES
 (702,901,9101,8,2,'issue',2,4,8,'2026-07-10 12:00+03','D5-OPEN-JULY-ISSUE'),
 (703,902,9201,9,2,'issue',2,4,8,'2026-07-10 12:00+03','D5-OTHER-TENANT-ISSUE');

\ir ../migrations/20261114191500_powerhub_financial_d5_inventory_item_accrual_classification_guard.sql

DO $tests$
DECLARE v_message text;
BEGIN
 IF (SELECT count(*) FROM pg_trigger
     WHERE NOT tgisinternal AND tgenabled='O'
       AND tgname='d5_inventory_item_accrual_classification_guard')<>1
 OR has_function_privilege('anon',
   'public.powerhub_financial_d5_guard_inventory_item_classification()','EXECUTE')
 OR has_function_privilege('authenticated',
   'public.powerhub_financial_d5_guard_inventory_item_classification()','EXECUTE')
 OR NOT has_function_privilege('service_role',
   'public.powerhub_financial_d5_guard_inventory_item_classification()','EXECUTE')
 THEN RAISE EXCEPTION 'D5_INSTALL_OR_ACL_BAD';END IF;

 IF (SELECT status FROM public.financial_accrual_period_reviews
   WHERE tenant_id=901 AND site_id=9101 AND period='2026-06') IS DISTINCT FROM 'locked'
 THEN RAISE EXCEPTION 'D5_JUNE_PRECONDITION_NOT_LOCKED';END IF;

 BEGIN
  UPDATE public.inventory_items SET category='other',accounting_treatment='capital_asset'
   WHERE id=7 AND tenant_id=901;
  RAISE EXCEPTION 'D5_CLOSED_COST_CLASSIFICATION_BYPASS';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
  IF v_message<>'D5_INVENTORY_CLASSIFICATION_ACCRUAL_PERIOD_LOCKED'
  THEN RAISE EXCEPTION 'D5_WRONG_CLOSED_REJECTION %',v_message;END IF;
 END;

 -- Closing the classification loophole must also reject changing only category.
 BEGIN
  UPDATE public.inventory_items SET category='other' WHERE id=7;
  RAISE EXCEPTION 'D5_CLOSED_CATEGORY_BYPASS';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
  IF v_message<>'D5_INVENTORY_CLASSIFICATION_ACCRUAL_PERIOD_LOCKED'
  THEN RAISE EXCEPTION 'D5_WRONG_CLOSED_CATEGORY_ERROR %',v_message;END IF;
 END;

 UPDATE public.inventory_items SET notes='description changed' WHERE id=7;
 IF (SELECT notes FROM public.inventory_items WHERE id=7) <> 'description changed'
 THEN RAISE EXCEPTION 'D5_BLOCKED_ALLOWED_METADATA';END IF;

 UPDATE public.inventory_items SET category='other',accounting_treatment='capital_asset'
  WHERE id=8 AND tenant_id=901;
 IF (SELECT accounting_treatment FROM public.inventory_items WHERE id=8)
   IS DISTINCT FROM 'capital_asset' THEN
  RAISE EXCEPTION 'D5_OPEN_MONTH_CLASSIFICATION_BLOCKED';END IF;

 UPDATE public.inventory_items SET category='other',accounting_treatment='capital_asset'
  WHERE id=9 AND tenant_id=902;
 IF (SELECT accounting_treatment FROM public.inventory_items WHERE id=9)
   IS DISTINCT FROM 'capital_asset' THEN
  RAISE EXCEPTION 'D5_UNRELATED_TENANT_CLASSIFICATION_BLOCKED';END IF;

 IF (SELECT category FROM public.inventory_items WHERE id=7)<>'spare_part'
 THEN RAISE EXCEPTION 'D5_CLOSED_ITEM_PARTIALLY_MUTATED';END IF;
 RAISE NOTICE 'D5_INVENTORY_CLASSIFICATION_C4_GUARD_PASS';
END $tests$;
SELECT 'D5_INVENTORY_CLASSIFICATION_C4_GUARD_PASS' AS result;


-- D8 independent-session May close vs classification race fixture.
-- Item 10 has only a May movement, so its old/new classification is valid
-- until C4 closes May. An AFTER UPDATE fixture dirties synthetic D2 coverage
-- only if classification wins the same C4 advisory period lock.
INSERT INTO public.inventory_items(id,tenant_id,category,accounting_treatment,notes)
VALUES(10,901,'spare_part','expense_on_issue','D8 May-only race item');
INSERT INTO public.inventory_stock_movements
 (id,tenant_id,site_id,item_id,warehouse_id,movement_type,quantity,
  unit_cost,total_cost_amount,occurred_at,operation_key)
VALUES(704,901,9101,10,2,'issue',1,4,4,'2026-05-15 12:00+03','D8-MAY-ONLY-ISSUE');
DO $pre$
BEGIN
 IF (SELECT status FROM public.financial_accrual_period_reviews
    WHERE tenant_id=901 AND site_id=9101 AND period='2026-05') IS DISTINCT FROM 'draft'
 THEN RAISE EXCEPTION 'D8_MAY_REVIEW_NOT_DRAFT';END IF;
 IF (SELECT COUNT(*) FROM public.inventory_stock_movements
   WHERE item_id=10 AND tenant_id=901 AND site_id=9101)<>1
 THEN RAISE EXCEPTION 'D8_MAY_ONLY_ITEM_FIXTURE_INVALID';END IF;
END $pre$;
CREATE OR REPLACE FUNCTION public.d8_mark_classification_source_dirty()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $fixture$
BEGIN
 IF NEW.id=10 AND OLD.accounting_treatment IS DISTINCT FROM NEW.accounting_treatment THEN
  UPDATE public.d2_sources
  SET blockers='{"invalidInventoryCount":1}'::jsonb
  WHERE tenant_id=901 AND site_id=9101 AND period='2026-05';
 END IF;
 RETURN NEW;
END $fixture$;
CREATE TRIGGER d8_classification_source_dirty
AFTER UPDATE OF accounting_treatment ON public.inventory_items
FOR EACH ROW EXECUTE FUNCTION public.d8_mark_classification_source_dirty();
SELECT 'D8_MAY_ITEM_VS_C4_RACE_FIXTURE_READY' result;
