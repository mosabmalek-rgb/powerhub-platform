\set ON_ERROR_STOP on
-- Run after inventory_purchase_receiving_workflow.sql in the same disposable
-- PostgreSQL database. This executes the ACTUAL migration and source RPCs.
\ir ../migrations/20261110024000_powerhub_inventory_atomic_auto_receipt.sql
BEGIN;
DO $auto_accept$
DECLARE
 warehouse bigint; supplier bigint; item bigint; purchase bigint;
 receipt bigint; payment bigint; pnumber text; rnumber text;
 replay_purchase bigint; replay_receipt bigint; retry boolean;
 qty numeric; stock_cost numeric; initial_receipts bigint;
 denied boolean; lines jsonb;
BEGIN
 SELECT id INTO warehouse FROM public.inventory_warehouses
 WHERE tenant_id=10 AND site_id=100 AND is_active ORDER BY id LIMIT 1;
 SELECT id INTO supplier FROM public.suppliers
 WHERE tenant_id=10 AND supplier_code='PUR-WF-SUP' AND is_active LIMIT 1;
 SELECT id INTO item FROM public.inventory_items
 WHERE tenant_id=10 AND sku='DSL-01' AND is_active LIMIT 1;
 IF warehouse IS NULL OR supplier IS NULL OR item IS NULL THEN
   RAISE EXCEPTION 'AUTO_RECEIPT_INTEGRATION_FIXTURE_MISSING'; END IF;
 lines:=jsonb_build_array(jsonb_build_object(
   'item_id',item,'quantity',2,'unit','liter','units_to_base_factor',1,
   'unit_price',3.50,'discount_amount',0,'tax_amount',0,'notes',null));
 SELECT a.purchase_id,a.receipt_id,a.purchase_number,a.receipt_number,a.replayed
 INTO purchase,receipt,pnumber,rnumber,retry
 FROM public.powerhub_inventory_purchase_auto_receive(
   10,100,1,supplier,warehouse,'AUTO-RECEIVE-TEST',
   current_date,current_date,0,'deferred',
   'AUTO-RECEIVE-REF','Atomic purchase receipt test',null,null,null,null,
   current_date,'ci-auto-receipt-20261109',lines) a;
 IF purchase IS NULL OR receipt IS NULL OR retry THEN
   RAISE EXCEPTION 'AUTO_RECEIPT_NOT_COMMITTED';END IF;
 SELECT count(*) INTO initial_receipts
 FROM public.supplier_purchase_receipts
 WHERE tenant_id=10 AND purchase_id=purchase;
 IF initial_receipts<>1 THEN RAISE EXCEPTION 'AUTO_RECEIPT_DUPLICATED';END IF;
 SELECT coalesce(sum(m.quantity),0),coalesce(sum(m.total_cost_amount),0)
 INTO qty,stock_cost
 FROM public.inventory_stock_movements m
 WHERE m.tenant_id=10 AND m.site_id=100
 AND m.purchase_id=purchase AND m.movement_type='purchase_receipt';
 IF qty<>2 OR stock_cost<>7
 OR NOT EXISTS(SELECT 1 FROM public.supplier_purchases p
   WHERE p.id=purchase AND p.tenant_id=10 AND p.site_id=100 AND p.status='received')
 THEN RAISE EXCEPTION 'AUTO_RECEIPT_STOCK_INCOMPLETE';END IF;
 SELECT a.purchase_id,a.receipt_id,a.replayed
 INTO replay_purchase,replay_receipt,retry
 FROM public.powerhub_inventory_purchase_auto_receive(
   10,100,1,supplier,warehouse,'AUTO-RECEIVE-TEST',
   current_date,current_date,0,'deferred',
   'AUTO-RECEIVE-REF','Atomic purchase receipt test',null,null,null,null,
   current_date,'ci-auto-receipt-20261109',lines) a;
 IF NOT retry OR replay_purchase<>purchase OR replay_receipt<>receipt
 OR (SELECT count(*) FROM public.supplier_purchase_receipts
     WHERE tenant_id=10 AND purchase_id=purchase)<>1
 THEN RAISE EXCEPTION 'AUTO_RECEIPT_REPLAY_DUPLICATED';END IF;
 denied:=false;
 BEGIN
   PERFORM public.powerhub_inventory_purchase_auto_receive(
     10,100,1,supplier,warehouse,'AUTO-RECEIVE-TEST',
     current_date,current_date,0,'deferred',
     'AUTO-RECEIVE-REF','Atomic purchase receipt test',null,null,null,null,
     current_date,'ci-auto-receipt-20261109',
     jsonb_build_array(jsonb_build_object(
       'item_id',item,'quantity',3,'unit','liter','units_to_base_factor',1,
       'unit_price',3.50,'discount_amount',0,'tax_amount',0,'notes',null)));
 EXCEPTION WHEN SQLSTATE 'P0001' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'AUTO_RECEIPT_CHANGED_PAYLOAD_ACCEPTED'; END IF;
 denied:=false;
 BEGIN
   PERFORM public.powerhub_inventory_purchase_auto_receive(
     10,101,1,supplier,warehouse,'AUTO-RECEIVE-REMOTE',
     current_date,current_date,0,'deferred',
     'AUTO-RECEIVE-REF','Wrong branch inventory',null,null,null,null,
     current_date,'ci-auto-receipt-other-site',lines);
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'AUTO_RECEIPT_CROSS_SITE_ALLOWED';END IF;
 IF has_function_privilege('anon','public.powerhub_inventory_purchase_auto_receive(bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,text,text,bigint,date,text,text,date,text,jsonb)','EXECUTE')
 OR has_function_privilege('authenticated','public.powerhub_inventory_purchase_auto_receive(bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,text,text,bigint,date,text,text,date,text,jsonb)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.powerhub_inventory_purchase_auto_receive(bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,text,text,bigint,date,text,text,date,text,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'AUTO_RECEIPT_EXECUTE_ACL_INCORRECT';END IF;
END;
$auto_accept$;
ROLLBACK;
SELECT 'PASS: automatic stock receipt exactly-once, cost, cross-site and permission checks' AS acceptance;
