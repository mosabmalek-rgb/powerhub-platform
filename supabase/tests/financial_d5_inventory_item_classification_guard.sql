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
