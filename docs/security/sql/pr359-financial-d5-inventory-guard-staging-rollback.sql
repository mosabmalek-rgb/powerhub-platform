-- PR359 D5 Staging acceptance AFTER exact 20261114191500 migration is installed.
-- Do not execute on Production. No persistent ledger, close, stock, or item changes.
-- Uses TECHNICAL evidence labels ONLY to exercise the real C4 review/lock RPC.
-- Verified Staging fixture: tenant=1, site=1, users=2 (maker),3 (checker),
-- inventory item=11 (spare_part/expense_on_issue), movement=21 (item 11),
-- and open-Nov item=9 (oil/expense_on_issue).
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='2s';
CREATE TEMP TABLE d5_acceptance_results(test_name text,result text) ON COMMIT DROP;
DO $accept$
DECLARE
 v_evidence jsonb:='{}'::jsonb;
 v_key text;
 v_msg text;
 v_before numeric;
 v_after numeric;
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM pg_trigger WHERE tgname='d5_inventory_item_accrual_classification_guard'
    AND tgenabled='O' AND NOT tgisinternal
 ) THEN RAISE EXCEPTION 'D5_MIGRATION_NOT_INSTALLED';END IF;
 IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews
   WHERE tenant_id=1 AND site_id=1 AND period='2026-09') THEN
  RAISE EXCEPTION 'D5_SEPTEMBER_REVIEW_ALREADY_EXISTS';END IF;
 IF (SELECT ROW(category,accounting_treatment) FROM public.inventory_items
      WHERE tenant_id=1 AND id=11) IS DISTINCT FROM
       ROW('spare_part'::text,'expense_on_issue'::text)
 THEN RAISE EXCEPTION 'D5_EXPECTED_ITEM_11_CLASSIFICATION_MISSING';END IF;

 INSERT INTO public.inventory_stock_movements
   (tenant_id,site_id,item_id,warehouse_id,movement_type,quantity,unit_cost,
    total_cost_amount,occurred_at,operation_key,created_by_user_id)
 SELECT tenant_id,site_id,item_id,warehouse_id,'opening_balance',0.02,unit_cost,
   unit_cost*0.02,'2026-09-05 12:00+03',
   'D5-ACCEPTANCE-ROLLBACK-OPEN',created_by_user_id
 FROM public.inventory_stock_movements WHERE id=21;
 INSERT INTO public.inventory_stock_movements
   (tenant_id,site_id,item_id,warehouse_id,movement_type,quantity,unit_cost,
    total_cost_amount,occurred_at,operation_key,created_by_user_id)
 SELECT tenant_id,site_id,item_id,warehouse_id,'issue',0.01,unit_cost,
   unit_cost*0.01,'2026-09-10 12:00+03',
   'D5-ACCEPTANCE-ROLLBACK-ISSUE',created_by_user_id
 FROM public.inventory_stock_movements WHERE id=21;

 v_before:=(public.powerhub_financial_accrual_month_statement(1,1,'2026-09',now())
   ->>'inventoryConsumptionCost')::numeric;
 IF v_before IS NULL OR v_before<=0 THEN RAISE EXCEPTION 'D5_NO_COST_FIXTURE'; END IF;
 FOREACH v_key IN ARRAY ARRAY[
 'unbilled_service','invoice_cutoff','supplier_reconciliation',
 'inventory_reconciliation','payroll_reconciliation','depreciation_register',
 'provision_assessment','tax_reconciliation'
 ] LOOP
  v_evidence:=v_evidence||jsonb_build_object(v_key,
   'D5 TECHNICAL ROLLBACK TEST - NOT ACCOUNTING EVIDENCE');
 END LOOP;
 PERFORM public.powerhub_financial_accrual_period_save_review(
   1,1,'2026-09',2,v_evidence);
 IF (public.powerhub_financial_accrual_period_lock(
   1,1,'2026-09',3)->>'status') IS DISTINCT FROM 'locked'
 THEN RAISE EXCEPTION 'D5_C4_CLOSE_FAILED';END IF;

 BEGIN
  UPDATE public.inventory_items SET category='other',
    accounting_treatment='capital_asset'
  WHERE tenant_id=1 AND id=11;
  RAISE EXCEPTION 'D5_CLOSED_PERIOD_CLASSIFICATION_ACCEPTED';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT;
  IF v_msg<>'D5_INVENTORY_CLASSIFICATION_ACCRUAL_PERIOD_LOCKED'
  THEN RAISE EXCEPTION 'D5_WRONG_CLOSED_ERROR %',v_msg;END IF;
 END;
 INSERT INTO pg_temp.d5_acceptance_results VALUES
  ('closed inventory classification rejected','PASS');

 v_after:=(public.powerhub_financial_accrual_month_statement(1,1,'2026-09',now())
    ->>'inventoryConsumptionCost')::numeric;
 IF v_after IS DISTINCT FROM v_before THEN
  RAISE EXCEPTION 'D5_COST_CHANGED % => %',v_before,v_after;
 END IF;
 INSERT INTO pg_temp.d5_acceptance_results VALUES
  ('closed cost preserved','PASS');

 UPDATE public.inventory_items SET name=name WHERE tenant_id=1 AND id=11;
 IF NOT FOUND THEN RAISE EXCEPTION 'D5_CLOSED_METADATA_BLOCKED';END IF;
 INSERT INTO pg_temp.d5_acceptance_results VALUES
  ('descriptive metadata allowed','PASS');

 -- An item with only November movements remains editable in November.
 UPDATE public.inventory_items SET category='other',
   accounting_treatment='capital_asset'
 WHERE tenant_id=1 AND id=9 AND category='oil';
 IF NOT FOUND THEN RAISE EXCEPTION 'D5_OPEN_PERIOD_CLASSIFICATION_BLOCKED'; END IF;
 INSERT INTO pg_temp.d5_acceptance_results VALUES
  ('open-month classification allowed','PASS');
END $accept$;

SELECT * FROM pg_temp.d5_acceptance_results ORDER BY test_name;
ROLLBACK;
-- Verify in a second request that all acceptance movements/reviews are absent.
