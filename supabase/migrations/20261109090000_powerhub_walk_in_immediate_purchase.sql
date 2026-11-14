-- Walk-in / unregistered supplier purchases: immediate and fully atomic.
-- A historical inactive supplier stub preserves mandatory FKs and audit trails,
-- but is never an active directory supplier or an unpaid trade creditor.
-- Apply via controlled, version-preserving Staging migration workflow.
ALTER TABLE public.supplier_purchases
  ADD COLUMN IF NOT EXISTS walk_in_payload_hash text;

CREATE OR REPLACE FUNCTION public.powerhub_inventory_create_walk_in_immediate_purchase(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_warehouse_id bigint,
  p_company_account_id bigint,
  p_supplier_invoice_no text,
  p_invoice_date date,
  p_payment_date date,
  p_reference_no text,
  p_notes text,
  p_payment_reference_no text,
  p_payment_notes text,
  p_operation_key text,
  p_lines jsonb
)
RETURNS TABLE (
  purchase_id bigint, purchase_number text, supplier_id bigint,
  payment_id bigint, account_transaction_id bigint,
  total_amount numeric, replayed boolean
)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public,pg_temp
AS $walk_in$
DECLARE
  v_operation_key text := nullif(btrim(p_operation_key), '');
  v_hash text;
  v_existing public.supplier_purchases%rowtype;
  v_supplier_id bigint;
  v_purchase_id bigint;
  v_purchase_number text;
  v_amount numeric;
  v_payment_id bigint;
  v_account_transaction_id bigint;
  v_outstanding numeric;
  v_supplier_code text;
BEGIN
  IF v_operation_key IS NULL OR length(v_operation_key)>180 THEN
    RAISE EXCEPTION 'INVALID_OPERATION_KEY' USING ERRCODE='P0001';
  END IF;
  IF p_invoice_date IS NULL OR p_payment_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_WALK_IN_DATE' USING ERRCODE='P0001';
  END IF;
  IF p_tenant_id IS NULL OR p_site_id IS NULL OR p_user_id IS NULL OR
     p_warehouse_id IS NULL OR p_company_account_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_WALK_IN_SCOPE' USING ERRCODE='P0001';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines)<1 THEN
    RAISE EXCEPTION 'INVALID_PURCHASE_LINES' USING ERRCODE='P0001';
  END IF;
  v_hash:=md5(jsonb_build_object(
    'site',p_site_id,'warehouse',p_warehouse_id,'account',p_company_account_id,
    'supplierInvoice',nullif(btrim(p_supplier_invoice_no),''),
    'invoiceDate',p_invoice_date,'paymentDate',p_payment_date,
    'reference',nullif(btrim(p_reference_no),''),'notes',nullif(btrim(p_notes),''),
    'paymentReference',nullif(btrim(p_payment_reference_no),''),
    'paymentNotes',nullif(btrim(p_payment_notes),''),
    'lines',p_lines
  )::text);
  -- Prevent concurrent duplicate walk-in purchases under the same key.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':walk-in-purchase:'||v_operation_key,0));

  SELECT sp.* INTO v_existing FROM public.supplier_purchases sp
  WHERE sp.tenant_id=p_tenant_id AND sp.operation_key=v_operation_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.walk_in_payload_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='P0001';
    END IF;
    SELECT pay.id,pay.account_transaction_id,
      greatest(0,v_existing.total_amount-coalesce(sum(alloc.amount),0))
    INTO v_payment_id,v_account_transaction_id,v_outstanding
    FROM public.supplier_payments pay
    JOIN public.supplier_payment_allocations alloc
      ON alloc.tenant_id=pay.tenant_id AND alloc.payment_id=pay.id
    WHERE pay.tenant_id=p_tenant_id AND pay.site_id=p_site_id
      AND pay.status='posted' AND alloc.purchase_id=v_existing.id
    GROUP BY pay.id,pay.account_transaction_id
    ORDER BY pay.id DESC LIMIT 1;
    IF v_payment_id IS NULL OR v_account_transaction_id IS NULL
      OR v_existing.status NOT IN ('confirmed','partially_received','received')
      OR v_existing.site_id<>p_site_id
      OR v_outstanding<>0 THEN
      RAISE EXCEPTION 'WALK_IN_PAYMENT_INCOMPLETE' USING ERRCODE='P0001';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.purchase_number,
      v_existing.supplier_id,v_payment_id,v_account_transaction_id,v_existing.total_amount,true;
    RETURN;
  END IF;

  -- This archived supplier reference is internal only: no active supplier registration.
  v_supplier_code:='WALKIN-'||md5(p_tenant_id::text||':'||v_operation_key);
  SELECT s.id INTO v_supplier_id
  FROM public.powerhub_inventory_create_supplier_with_type(
    p_tenant_id,p_site_id,p_user_id,v_supplier_code,'مورد غير مسجل',
    NULL,NULL,NULL,NULL,NULL,0,'مرجع شراء فوري غير مسجل','one_time'
  ) s;

  SELECT p.purchase_id,p.purchase_number,p.total_amount
    INTO v_purchase_id,v_purchase_number,v_amount
  FROM public.powerhub_inventory_create_purchase(
    p_tenant_id,p_site_id,p_user_id,v_supplier_id,p_warehouse_id,
    nullif(btrim(p_supplier_invoice_no),''),p_invoice_date,p_invoice_date,0,
    nullif(btrim(p_reference_no),''),nullif(btrim(p_notes),''),
    v_operation_key,p_lines,'immediate'
  ) p;
  IF v_purchase_id IS NULL OR v_amount IS NULL OR v_amount<=0 THEN
    RAISE EXCEPTION 'INVALID_WALK_IN_TOTAL' USING ERRCODE='P0001';
  END IF;
  UPDATE public.supplier_purchases sp
    SET walk_in_payload_hash=v_hash
    WHERE sp.tenant_id=p_tenant_id AND sp.id=v_purchase_id;

  PERFORM 1 FROM public.powerhub_inventory_confirm_purchase(
    p_tenant_id,p_site_id,p_user_id,v_purchase_id
  );
  SELECT pay.payment_id,pay.account_transaction_id,pay.outstanding_amount
    INTO v_payment_id,v_account_transaction_id,v_outstanding
  FROM public.powerhub_inventory_record_supplier_payment(
    p_tenant_id,p_site_id,p_user_id,v_purchase_id,p_company_account_id,
    v_amount,p_payment_date,nullif(btrim(p_payment_reference_no),''),
    coalesce(nullif(btrim(p_payment_notes),''),'سداد فوري لمشتريات من مورد غير مسجل'),
    v_operation_key||':paid'
  ) pay;

  IF v_payment_id IS NULL OR v_account_transaction_id IS NULL OR v_outstanding<>0 THEN
    RAISE EXCEPTION 'WALK_IN_PAYMENT_INCOMPLETE' USING ERRCODE='P0001';
  END IF;

  UPDATE public.suppliers s SET is_active=false,updated_at=now()
    WHERE s.tenant_id=p_tenant_id AND s.id=v_supplier_id;

  RETURN QUERY SELECT v_purchase_id,v_purchase_number,v_supplier_id,
    v_payment_id,v_account_transaction_id,v_amount,false;
END;
$walk_in$;

-- RPC is invoked only by the server's service-role client after the three
-- capability gates, never by anon/authenticated or PUBLIC.
REVOKE ALL ON FUNCTION public.powerhub_inventory_create_walk_in_immediate_purchase(
  bigint,bigint,bigint,bigint,bigint,text,date,date,text,text,text,text,text,jsonb
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_inventory_create_walk_in_immediate_purchase(
  bigint,bigint,bigint,bigint,bigint,text,date,date,text,text,text,text,text,jsonb
) TO service_role;
COMMENT ON FUNCTION public.powerhub_inventory_create_walk_in_immediate_purchase(
  bigint,bigint,bigint,bigint,bigint,text,date,date,text,text,text,text,text,jsonb
) IS 'Atomic, idempotent immediate purchase for an unregistered supplier. Archives an inactive FK supplier and never leaves a payable if payment fails.';
NOTIFY pgrst,'reload schema';
