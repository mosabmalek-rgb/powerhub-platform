-- D4: serialize payroll, supplier purchase, inventory issue and payroll-item
-- source changes against the *same* C4 accrual close advisory month key.
-- No automatic release: apply only through version-exact protected Staging workflow.
-- D3 invoice/expense triggers stay untouched.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_guard_d4_sources()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
DECLARE
  v_old jsonb; v_new jsonb; v_row jsonb;
  v_changed boolean:=true;
  v_scopes jsonb:='[]'::jsonb;
  v_tenant bigint;v_site bigint;v_period text;v_date text;
  v_parent bigint;v_ref_field text;v_ref_id bigint;v_ref record;
  v_scope record;
BEGIN
 IF TG_TABLE_NAME NOT IN
  ('payroll_runs','payroll_items','supplier_purchases','inventory_stock_movements')
 THEN RAISE EXCEPTION 'D4_UNSUPPORTED_SOURCE' USING ERRCODE='22023';END IF;
 IF TG_OP<>'INSERT' THEN v_old:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN v_new:=to_jsonb(NEW);END IF;

 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='payroll_runs' THEN
   v_changed:=ROW(OLD.tenant_id,OLD.site_id,OLD.period,OLD.status,
     OLD.total_gross,OLD.total_deductions,OLD.total_net,
     OLD.paid_from_account_id,OLD.approved_by_user_id,OLD.paid_at)
   IS DISTINCT FROM ROW(NEW.tenant_id,NEW.site_id,NEW.period,NEW.status,
     NEW.total_gross,NEW.total_deductions,NEW.total_net,
     NEW.paid_from_account_id,NEW.approved_by_user_id,NEW.paid_at);
  ELSIF TG_TABLE_NAME='payroll_items' THEN
   v_changed:=ROW(OLD.payroll_run_id,OLD.employee_id,OLD.base_amount,
       OLD.extra_amount,OLD.advance_deduction,OLD.other_deduction,OLD.net_amount)
   IS DISTINCT FROM ROW(NEW.payroll_run_id,NEW.employee_id,NEW.base_amount,
       NEW.extra_amount,NEW.advance_deduction,NEW.other_deduction,NEW.net_amount);
  ELSIF TG_TABLE_NAME='supplier_purchases' THEN
   v_changed:=ROW(OLD.tenant_id,OLD.site_id,OLD.supplier_id,OLD.warehouse_id,
     OLD.invoice_date,OLD.status,OLD.subtotal_amount,OLD.discount_amount,
     OLD.tax_amount,OLD.other_charges_amount,OLD.total_amount,
     OLD.payment_mode,OLD.received_at,OLD.confirmed_at,OLD.cancelled_at,
     OLD.supplier_invoice_no)
   IS DISTINCT FROM ROW(NEW.tenant_id,NEW.site_id,NEW.supplier_id,NEW.warehouse_id,
     NEW.invoice_date,NEW.status,NEW.subtotal_amount,NEW.discount_amount,
     NEW.tax_amount,NEW.other_charges_amount,NEW.total_amount,
     NEW.payment_mode,NEW.received_at,NEW.confirmed_at,NEW.cancelled_at,
     NEW.supplier_invoice_no);
  ELSE
   v_changed:=ROW(OLD.tenant_id,OLD.site_id,OLD.item_id,OLD.warehouse_id,
     OLD.generator_id,OLD.movement_type,OLD.quantity,OLD.unit_cost,
     OLD.total_cost_amount,OLD.occurred_at,OLD.reversal_of_movement_id,
     OLD.corrects_movement_id,OLD.source_issue_movement_id,OLD.purchase_id,
     OLD.purchase_line_id,OLD.operation_key)
   IS DISTINCT FROM ROW(NEW.tenant_id,NEW.site_id,NEW.item_id,NEW.warehouse_id,
     NEW.generator_id,NEW.movement_type,NEW.quantity,NEW.unit_cost,
     NEW.total_cost_amount,NEW.occurred_at,NEW.reversal_of_movement_id,
     NEW.corrects_movement_id,NEW.source_issue_movement_id,NEW.purchase_id,
     NEW.purchase_line_id,NEW.operation_key);
  END IF;
 END IF;
 IF NOT v_changed THEN
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;
  RETURN NEW;
 END IF;

 -- Both old and new financial scopes are locked in a stable order.
 FOR v_row IN
  SELECT v_old WHERE v_old IS NOT NULL
  UNION ALL SELECT v_new WHERE v_new IS NOT NULL
 LOOP
  IF TG_TABLE_NAME='payroll_items' THEN
   v_parent:=(v_row->>'payroll_run_id')::bigint;
   SELECT p.tenant_id,p.site_id,p.period INTO v_tenant,v_site,v_period
     FROM public.payroll_runs p WHERE p.id=v_parent;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'D4_PAYROLL_PARENT_MISSING' USING ERRCODE='23503';
   END IF;
  ELSE
   v_tenant:=(v_row->>'tenant_id')::bigint;
   v_site:=(v_row->>'site_id')::bigint;
   IF TG_TABLE_NAME='payroll_runs' THEN
    v_period:=v_row->>'period';
   ELSIF TG_TABLE_NAME='supplier_purchases' THEN
    v_period:=to_char((v_row->>'invoice_date')::date,'YYYY-MM');
   ELSE
    v_period:=to_char(((v_row->>'occurred_at')::timestamptz AT TIME ZONE 'Asia/Gaza')::date,'YYYY-MM');
   END IF;
  END IF;
  IF v_tenant IS NULL OR v_tenant<=0 THEN
    RAISE EXCEPTION 'D4_INVALID_TENANT' USING ERRCODE='22023';END IF;
  -- Company-wide payroll_run (site_id NULL) is NOT a site-scoped source.
  -- It requires a separate central allocation/close design; do not invent
  -- allocation to a branch, nor assert that site close certifies it.
  IF v_site IS NOT NULL THEN
   IF v_site<=0 OR v_period IS NULL OR
      v_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR left(v_period,4)='0000'
   THEN RAISE EXCEPTION 'D4_INVALID_SOURCE_SCOPE_OR_PERIOD' USING ERRCODE='22023'; END IF;
   v_scopes:=v_scopes||jsonb_build_array(jsonb_build_object(
     'tenant',v_tenant,'site',v_site,'period',v_period));
  END IF;

  -- Reversal/correction of a historical consumption changes the original
  -- month’s recognized cost even if the reversing movement is dated later.
  IF TG_TABLE_NAME='inventory_stock_movements' THEN
   FOREACH v_ref_field IN ARRAY ARRAY[
     'reversal_of_movement_id','corrects_movement_id','source_issue_movement_id'
   ] LOOP
     v_ref_id:=NULLIF(v_row->>v_ref_field,'')::bigint;
     IF v_ref_id IS NULL THEN CONTINUE;END IF;
     SELECT m.tenant_id,m.site_id,m.occurred_at INTO v_ref
       FROM public.inventory_stock_movements m WHERE m.id=v_ref_id;
     IF NOT FOUND OR v_ref.tenant_id IS DISTINCT FROM v_tenant
       OR v_ref.site_id IS DISTINCT FROM v_site THEN
       RAISE EXCEPTION 'D4_INVALID_CROSS_SCOPE_MOVEMENT_REFERENCE' USING ERRCODE='42501';
     END IF;
     v_scopes:=v_scopes||jsonb_build_array(jsonb_build_object(
       'tenant',v_ref.tenant_id,'site',v_ref.site_id,
       'period',to_char((v_ref.occurred_at AT TIME ZONE 'Asia/Gaza')::date,'YYYY-MM')));
   END LOOP;
  END IF;
 END LOOP;

 FOR v_scope IN
   SELECT DISTINCT x.tenant,x.site,x.period
   FROM jsonb_to_recordset(v_scopes) AS x(tenant bigint,site bigint,period text)
   ORDER BY x.tenant,x.site,x.period
 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended(
     'powerhub:accrual-period:'||v_scope.tenant||':'||v_scope.site||':'||v_scope.period,0));
   IF EXISTS(SELECT 1 FROM public.financial_accrual_period_reviews r
     WHERE r.tenant_id=v_scope.tenant AND r.site_id=v_scope.site
       AND r.period=v_scope.period AND r.status='locked')
   THEN RAISE EXCEPTION 'D4_ACCRUAL_SOURCE_PERIOD_LOCKED' USING ERRCODE='22023';
   END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END
$guard$;

REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_guard_d4_sources()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_guard_d4_sources()
  TO service_role;

DROP TRIGGER IF EXISTS d4_accrual_payroll_runs_guard ON public.payroll_runs;
CREATE TRIGGER d4_accrual_payroll_runs_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_runs
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_guard_d4_sources();

DROP TRIGGER IF EXISTS d4_accrual_payroll_items_guard ON public.payroll_items;
CREATE TRIGGER d4_accrual_payroll_items_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_items
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_guard_d4_sources();

DROP TRIGGER IF EXISTS d4_accrual_supplier_purchases_guard ON public.supplier_purchases;
CREATE TRIGGER d4_accrual_supplier_purchases_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_purchases
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_guard_d4_sources();

DROP TRIGGER IF EXISTS d4_accrual_inventory_movements_guard ON public.inventory_stock_movements;
CREATE TRIGGER d4_accrual_inventory_movements_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_stock_movements
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_guard_d4_sources();

COMMENT ON FUNCTION public.powerhub_financial_accrual_guard_d4_sources() IS
 'D4 site-month writer guard for payroll, payroll items, supplier purchases, inventory, including historical source movement references; companywide payroll and other cash-source tables remain separately unaccepted.';
NOTIFY pgrst,'reload schema';
