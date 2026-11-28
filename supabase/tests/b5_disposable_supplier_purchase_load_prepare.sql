\set ON_ERROR_STOP on
-- Disposable B5 supplier stock purchasing, receiving and payment RPC load.
-- Intentionally runs AFTER the complete inventory integration fixture.
DO $guard$ BEGIN
 IF current_database()<>'inventory_purchase_receiving_test'
 THEN RAISE EXCEPTION 'B5_SUPPLIER_REQUIRES_DISPOSABLE_INVENTORY_TEST_DATABASE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.suppliers WHERE tenant_id=10 AND supplier_code='PUR-WF-SUP')
 OR NOT EXISTS(SELECT 1 FROM public.inventory_items WHERE tenant_id=10 AND sku='PUR-WF-ITEM-01')
 OR NOT EXISTS(SELECT 1 FROM public.inventory_warehouses WHERE tenant_id=10 AND site_id=100 AND code='PUR-WF-MAIN')
 THEN RAISE EXCEPTION 'B5_SUPPLIER_MISSING_TEST_FIXTURES'; END IF;
END $guard$;
-- Increase test-only opening balance: the original fixture may have spent most of 500.
UPDATE public.company_accounts SET opening_balance=1000000 WHERE tenant_id=10 AND id=1000;
CREATE TABLE public.b5_supplier_load_samples(
 worker int NOT NULL CHECK(worker BETWEEN 1 AND 4),
 iteration int NOT NULL CHECK(iteration BETWEEN 1 AND 25),
 backend_pid int NOT NULL,
 replay boolean NOT NULL,
 purchase_id bigint NOT NULL,payment_id bigint NOT NULL,
 elapsed_ms numeric NOT NULL CHECK(elapsed_ms>=0),
 PRIMARY KEY(worker,iteration));
GRANT SELECT,INSERT ON public.b5_supplier_load_samples TO service_role;

CREATE OR REPLACE FUNCTION public.b5_supplier_load_one(p_worker int,p_iteration int)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp
AS $fn$
DECLARE
 v_n int;v_supplier bigint;v_item bigint;v_wh bigint;v_purchase bigint;v_total numeric;
 v_line bigint;v_status text;v_receipt bigint;v_payment bigint;v_tx bigint;
 v_replay boolean;v_receipt_replay boolean;v_payment_replay boolean;
 v_amount numeric;v_started timestamptz;v_period date:=current_date;
BEGIN
 IF current_database()<>'inventory_purchase_receiving_test'
 OR p_worker NOT BETWEEN 1 AND 4 OR p_iteration NOT BETWEEN 1 AND 25
 THEN RAISE EXCEPTION 'B5_SUPPLIER_INVALID_TEST_SCOPE'; END IF;
 v_n:=(p_worker-1)*25+p_iteration;
 IF v_n=100 THEN v_n:=1; END IF;
 v_amount:=CASE WHEN v_n=20 THEN 1.5 ELSE 1 END;
 SELECT id INTO v_supplier FROM public.suppliers
 WHERE tenant_id=10 AND supplier_code='PUR-WF-SUP';
 SELECT id INTO v_item FROM public.inventory_items
 WHERE tenant_id=10 AND sku='PUR-WF-ITEM-01';
 SELECT id INTO v_wh FROM public.inventory_warehouses
 WHERE tenant_id=10 AND site_id=100 AND code='PUR-WF-MAIN';
 v_started:=clock_timestamp();
 SELECT purchase_id,total_amount,replayed INTO v_purchase,v_total,v_replay
 FROM public.powerhub_inventory_create_purchase(
  10,100,1,v_supplier,v_wh,'B5-SUP-INV-'||v_n,v_period,NULL,30,
  'B5-SUP-REF-'||v_n,'Synthetic supplier inventory purchase',
  'b5:supplier:create:'||v_n,
  jsonb_build_array(jsonb_build_object('item_id',v_item,'quantity',1,
   'unit','liter','units_to_base_factor',1,'unit_price',v_amount,
   'discount_amount',0,'tax_amount',0,'notes','synthetic receipt')));
 IF v_purchase IS NULL OR v_total<>v_amount
 OR v_replay IS DISTINCT FROM (p_worker=4 AND p_iteration=25)
 THEN RAISE EXCEPTION 'B5_SUPPLIER_CREATE_OR_REPLAY_DRIFT'; END IF;
 IF NOT v_replay THEN
   SELECT status INTO v_status FROM public.powerhub_inventory_confirm_purchase(
     10,100,1,v_purchase);
   IF v_status<>'confirmed' THEN RAISE EXCEPTION 'B5_SUPPLIER_CONFIRM_FAILED';END IF;
   SELECT id INTO v_line FROM public.supplier_purchase_lines
    WHERE tenant_id=10 AND purchase_id=v_purchase LIMIT 1;
   IF v_line IS NULL THEN RAISE EXCEPTION 'B5_SUPPLIER_MISSING_PURCHASE_LINE'; END IF;
   SELECT receipt_id,purchase_status,replayed INTO v_receipt,v_status,v_receipt_replay
   FROM public.powerhub_inventory_receive_purchase(
     10,100,1,v_purchase,v_period,'b5:supplier:receipt:'||v_n,
     'Synthetic full warehouse receipt',
     jsonb_build_array(jsonb_build_object('purchase_line_id',v_line,'quantity',1)));
   IF v_receipt IS NULL OR v_status<>'received' OR v_receipt_replay
   THEN RAISE EXCEPTION 'B5_SUPPLIER_STOCK_RECEIPT_FAILED %',v_status; END IF;
 END IF;
 SELECT payment_id,account_transaction_id,replayed
 INTO v_payment,v_tx,v_payment_replay
 FROM public.powerhub_inventory_record_supplier_payment(
   10,100,2,v_purchase,1000,v_amount,v_period,'B5-SUP-PAY-'||v_n,
   'Synthetic supplier payment','b5:supplier:payment:'||v_n);
 IF v_payment IS NULL OR v_tx IS NULL OR v_payment_replay IS DISTINCT FROM v_replay
 THEN RAISE EXCEPTION 'B5_SUPPLIER_PAYMENT_OR_REPLAY_FAILED'; END IF;
 INSERT INTO public.b5_supplier_load_samples(
 worker,iteration,backend_pid,replay,purchase_id,payment_id,elapsed_ms)
 VALUES(p_worker,p_iteration,pg_backend_pid(),v_replay,v_purchase,v_payment,
  round(extract(epoch FROM clock_timestamp()-v_started)::numeric*1000,3));
 RETURN 'SUPPLIER_OK';
END $fn$;
REVOKE ALL ON FUNCTION public.b5_supplier_load_one(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.b5_supplier_load_one(integer,integer) TO service_role;
SELECT 'B5_SUPPLIER_PURCHASE_RECEIPT_PAYMENT_DISPOSABLE_FIXTURE_READY' AS result;
