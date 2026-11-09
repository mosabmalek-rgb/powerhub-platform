-- Optional verified automatic receipt, selected under the purchase warehouse.
-- All operations execute within ONE database transaction: purchase creation,
-- supplier confirmation, full physical receipt, and optional immediate payment.
-- A failure in ANY stage rolls back ALL stages, including money and stock.
-- The operation key and derived receipt/payment keys provide exactly-once replay.
-- Manual purchase and later partial receiving remain unchanged.
CREATE OR REPLACE FUNCTION public.powerhub_inventory_purchase_auto_receive(
 p_tenant_id bigint,
 p_site_id bigint,
 p_user_id bigint,
 p_supplier_id bigint,
 p_warehouse_id bigint,
 p_supplier_invoice_no text,
 p_invoice_date date,
 p_due_date date,
 p_payment_terms_days integer,
 p_payment_mode text,
 p_reference_no text,
 p_notes text,
 p_company_account_id bigint,
 p_payment_date date,
 p_payment_reference_no text,
 p_payment_notes text,
 p_receipt_date date,
 p_operation_key text,
 p_lines jsonb
) RETURNS TABLE(
 purchase_id bigint,purchase_number text,purchase_status text,
 receipt_id bigint,receipt_number text,payment_id bigint,replayed boolean
)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $auto$
DECLARE
 v_purchase_id bigint;
 v_purchase_number text;
 v_created_replayed boolean;
 v_existing_status text;
 v_receipt_id bigint;
 v_receipt_number text;
 v_receipt_replayed boolean;
 v_payment_id bigint;
 v_lines jsonb;
 v_amount numeric;
 v_receipt_date date;
 v_mode text;
 v_received_qty numeric;
 v_total_qty numeric;
BEGIN
 IF p_tenant_id IS NULL OR p_tenant_id<=0
 OR p_site_id IS NULL OR p_site_id<=0 OR p_user_id IS NULL OR p_user_id<=0
 OR p_warehouse_id IS NULL OR p_warehouse_id<=0
 OR p_invoice_date IS NULL OR p_receipt_date IS NULL
 OR p_operation_key IS NULL OR length(btrim(p_operation_key)) NOT BETWEEN 8 AND 155
 OR p_lines IS NULL OR jsonb_typeof(p_lines)<>'array'
 OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'AUTO_RECEIPT_REQUEST_INVALID' USING ERRCODE='22023'; END IF;
 v_mode:=coalesce(p_payment_mode,'deferred');
 IF v_mode NOT IN ('deferred','immediate')
 OR (p_supplier_id IS NULL AND v_mode<>'immediate')
 OR (v_mode='immediate' AND (p_company_account_id IS NULL
     OR p_company_account_id<=0 OR p_payment_date IS NULL))
 THEN RAISE EXCEPTION 'AUTO_RECEIPT_PAYMENT_MODE_INVALID' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.inventory_warehouses w
   WHERE w.id=p_warehouse_id AND w.tenant_id=p_tenant_id
   AND w.site_id=p_site_id AND w.is_active)
 THEN RAISE EXCEPTION 'AUTO_RECEIPT_WAREHOUSE_OUT_OF_SCOPE'
   USING ERRCODE='22023'; END IF;
 -- The creation RPC locks its own request key, and the receiving RPC locks
 -- the purchase. This separate stable lock also serializes two auto-flow
 -- attempts regardless of the underlying purchase kind.
 PERFORM pg_advisory_xact_lock(hashtextextended(
   'powerhub:auto-receive:'||p_tenant_id||':'||btrim(p_operation_key),0));
 IF p_supplier_id IS NULL THEN
   SELECT p.purchase_id,p.purchase_number,p.replayed
     INTO v_purchase_id,v_purchase_number,v_created_replayed
   FROM public.powerhub_inventory_create_walk_in_immediate_purchase(
     p_tenant_id,p_site_id,p_user_id,p_warehouse_id,p_company_account_id,
     p_supplier_invoice_no,p_invoice_date,p_payment_date,
     p_reference_no,p_notes,p_payment_reference_no,p_payment_notes,
     btrim(p_operation_key),p_lines) p;
 ELSE
   SELECT p.purchase_id,p.purchase_number,p.replayed
     INTO v_purchase_id,v_purchase_number,v_created_replayed
   FROM public.powerhub_inventory_create_purchase(
     p_tenant_id,p_site_id,p_user_id,p_supplier_id,p_warehouse_id,
     p_supplier_invoice_no,p_invoice_date,p_due_date,p_payment_terms_days,
     p_reference_no,p_notes,btrim(p_operation_key),p_lines,v_mode) p;
 END IF;
 IF v_purchase_id IS NULL THEN
   RAISE EXCEPTION 'AUTO_RECEIPT_PURCHASE_NOT_CREATED'
     USING ERRCODE='23514'; END IF;
 SELECT p.status,p.total_amount INTO v_existing_status,v_amount
 FROM public.supplier_purchases p
 WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
   AND p.id=v_purchase_id AND p.warehouse_id=p_warehouse_id
 FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'AUTO_RECEIPT_PURCHASE_SCOPE_CHANGED'
     USING ERRCODE='22023'; END IF;
 IF v_created_replayed THEN
   -- Only the COMPLETE original transaction can be retried. A purchase
   -- created by a manual workflow with the same key must NOT be promoted
   -- to received on a later, supposedly idempotent auto-flow retry.
   IF v_existing_status<>'received'
   OR NOT EXISTS(SELECT 1 FROM public.supplier_purchase_receipts r
      WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id
        AND r.purchase_id=v_purchase_id
        AND r.operation_key=btrim(p_operation_key)||':receipt')
   THEN RAISE EXCEPTION 'AUTO_RECEIPT_INCOMPLETE_REPLAY'
     USING ERRCODE='23505'; END IF;
 ELSE
   -- Registered suppliers create a draft; one transaction approves it.
   -- Walk-in immediate already contains its own atomic confirmation/payment.
   IF p_supplier_id IS NOT NULL THEN
     PERFORM 1 FROM public.powerhub_inventory_confirm_purchase(
       p_tenant_id,p_site_id,p_user_id,v_purchase_id);
   END IF;
 END IF;
 SELECT count(*),coalesce(jsonb_agg(jsonb_build_object(
      'purchase_line_id',l.id,'quantity',l.quantity) ORDER BY l.id),'[]'::jsonb),
      coalesce(sum(l.quantity),0)
 INTO STRICT v_total_qty,v_lines,v_received_qty
 FROM public.supplier_purchase_lines l
 WHERE l.tenant_id=p_tenant_id AND l.purchase_id=v_purchase_id;
 IF v_total_qty<>jsonb_array_length(p_lines) OR v_received_qty<=0
 THEN RAISE EXCEPTION 'AUTO_RECEIPT_LINE_COUNT_MISMATCH'
   USING ERRCODE='23514'; END IF;
 v_receipt_date:=p_receipt_date;
 SELECT r.receipt_id,r.receipt_number,r.replayed
 INTO v_receipt_id,v_receipt_number,v_receipt_replayed
 FROM public.powerhub_inventory_receive_purchase(
   p_tenant_id,p_site_id,p_user_id,v_purchase_id,v_receipt_date,
   btrim(p_operation_key)||':receipt',
   'استلام تلقائي مؤكد من شاشة المشتريات',v_lines) r;
 IF v_receipt_id IS NULL THEN
   RAISE EXCEPTION 'AUTO_RECEIPT_RECEIPT_NOT_CREATED'
     USING ERRCODE='23514';END IF;
 IF p_supplier_id IS NOT NULL AND v_mode='immediate' THEN
   SELECT pay.payment_id INTO v_payment_id
   FROM public.powerhub_inventory_record_supplier_payment(
     p_tenant_id,p_site_id,p_user_id,v_purchase_id,
     p_company_account_id,v_amount,p_payment_date,p_payment_reference_no,
     coalesce(nullif(btrim(p_payment_notes),''),
      'سداد فوري لمشتريات مستلمة تلقائيًا'),
     btrim(p_operation_key)||':payment') pay;
   IF v_payment_id IS NULL THEN
     RAISE EXCEPTION 'AUTO_RECEIPT_PAYMENT_NOT_POSTED'
       USING ERRCODE='23514';END IF;
 ELSIF p_supplier_id IS NULL THEN
   SELECT s.id INTO v_payment_id FROM public.supplier_payments s
   JOIN public.supplier_payment_allocations alloc
     ON alloc.tenant_id=s.tenant_id AND alloc.payment_id=s.id
   WHERE s.tenant_id=p_tenant_id AND s.site_id=p_site_id
     AND alloc.purchase_id=v_purchase_id AND s.status='posted'
   ORDER BY s.id DESC LIMIT 1;
   IF v_payment_id IS NULL THEN
     RAISE EXCEPTION 'AUTO_RECEIPT_WALK_IN_PAYMENT_MISSING'
       USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT EXISTS(
   SELECT 1 FROM public.supplier_purchases p
   WHERE p.id=v_purchase_id AND p.tenant_id=p_tenant_id
     AND p.site_id=p_site_id AND p.status='received')
 OR EXISTS(
   SELECT 1 FROM public.supplier_purchase_lines l
   WHERE l.tenant_id=p_tenant_id AND l.purchase_id=v_purchase_id
     AND l.received_quantity<>l.quantity)
 THEN RAISE EXCEPTION 'AUTO_RECEIPT_NOT_FULLY_RECEIVED'
   USING ERRCODE='23514'; END IF;
 RETURN QUERY SELECT v_purchase_id,v_purchase_number,'received'::text,
    v_receipt_id,v_receipt_number,v_payment_id,v_created_replayed;
END;
$auto$;
REVOKE ALL ON FUNCTION public.powerhub_inventory_purchase_auto_receive(
 bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,
 text,text,bigint,date,text,text,date,text,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_inventory_purchase_auto_receive(
 bigint,bigint,bigint,bigint,bigint,text,date,date,integer,text,
 text,text,bigint,date,text,text,date,text,jsonb)
 TO service_role;
NOTIFY pgrst,'reload schema';
