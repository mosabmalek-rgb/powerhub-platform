-- PowerHub Phase D3 — source-write serialization with accrual-period C4 close.
-- Apply ONLY through the protected, exact-version Staging migration workflow.
-- Handles expense source rows and RECOGNIZED invoice source rows. Do not mistake
-- this for full operational-source coverage; payroll, inventory, purchases,
-- payments and account changes require separately tested guards.
CREATE OR REPLACE FUNCTION public.powerhub_financial_accrual_guard_source_write()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $guard$
DECLARE
 v_old jsonb; v_new jsonb; v_scopes jsonb:='[]'::jsonb;
 v_row jsonb; v_side text; v_active boolean; v_changed boolean:=true;
 v_tenant bigint;v_site bigint;v_month text;v_event text;
 v_scope record;
BEGIN
 IF TG_TABLE_NAME NOT IN ('expenses','invoices') THEN
   RAISE EXCEPTION 'D3_UNSUPPORTED_SOURCE_%',TG_TABLE_NAME USING ERRCODE='22023';
 END IF;
 IF TG_OP<>'INSERT' THEN v_old:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN v_new:=to_jsonb(NEW);END IF;

 IF TG_TABLE_NAME='expenses' AND TG_OP='UPDATE' THEN
   v_changed:=ROW(OLD.tenant_id,OLD.site_id,OLD.category,OLD.amount,
                  OLD.occurred_at,OLD.expense_classification,
                  OLD.company_account_id,OLD.reference_no)
      IS DISTINCT FROM
              ROW(NEW.tenant_id,NEW.site_id,NEW.category,NEW.amount,
                  NEW.occurred_at,NEW.expense_classification,
                  NEW.company_account_id,NEW.reference_no);
 END IF;
 IF TG_TABLE_NAME='invoices' AND TG_OP='UPDATE' THEN
   -- Payment progress (paid_amount/balance_due) and transitions among recognized
   -- states do not revise service revenue; they must remain possible after close.
   v_changed:=ROW(OLD.tenant_id,OLD.site_id,OLD.subscriber_id,OLD.cycle_key,
                  OLD.cycle_start_at,OLD.cycle_end_at,OLD.issue_date,
                  OLD.total_amount,OLD.tax_amount,OLD.discount_amount,
                  OLD.fixed_fee,OLD.price_per_kwh,OLD.consumption_kwh,
                  OLD.status IN ('issued','overdue','partially_paid','paid'))
     IS DISTINCT FROM
              ROW(NEW.tenant_id,NEW.site_id,NEW.subscriber_id,NEW.cycle_key,
                  NEW.cycle_start_at,NEW.cycle_end_at,NEW.issue_date,
                  NEW.total_amount,NEW.tax_amount,NEW.discount_amount,
                  NEW.fixed_fee,NEW.price_per_kwh,NEW.consumption_kwh,
                  NEW.status IN ('issued','overdue','partially_paid','paid'));
 END IF;
 IF NOT v_changed THEN
   IF TG_OP='DELETE' THEN RETURN OLD;END IF;
   RETURN NEW;
 END IF;

 FOR v_side,v_row IN
   SELECT 'old',v_old WHERE v_old IS NOT NULL
   UNION ALL SELECT 'new',v_new WHERE v_new IS NOT NULL
 LOOP
   v_active:=TG_TABLE_NAME='expenses' OR
     (v_row->>'status' IN ('issued','overdue','partially_paid','paid'));
   IF NOT v_active THEN CONTINUE;END IF;
   v_tenant:=(v_row->>'tenant_id')::bigint;
   v_site:=(v_row->>'site_id')::bigint;
   IF v_tenant IS NULL OR v_tenant<=0 OR v_site IS NULL OR v_site<=0 THEN
      RAISE EXCEPTION 'D3_INVALID_SOURCE_SCOPE' USING ERRCODE='22023';
   END IF;
   IF TG_TABLE_NAME='expenses' THEN
      v_event:=v_row->>'occurred_at';
      IF v_event IS NULL THEN
         RAISE EXCEPTION 'D3_SOURCE_TIMESTAMP_MISSING' USING ERRCODE='22023';
      END IF;
      v_month:=to_char((v_event::timestamptz AT TIME ZONE 'Asia/Gaza')::date,'YYYY-MM');
      v_scopes:=v_scopes||jsonb_build_array(
         jsonb_build_object('tenant_id',v_tenant,'site_id',v_site,'period',v_month));
   ELSE
      -- C4 source cut-off references invoice cycle-end and issue month.
      -- Protect both before/after scope and both cut-off dimensions.
      FOR v_event IN SELECT DISTINCT x.val
        FROM (VALUES(v_row->>'cycle_end_at'),(v_row->>'issue_date')) x(val)
        WHERE x.val IS NOT NULL
      LOOP
        v_month:=to_char((v_event::timestamptz AT TIME ZONE 'Asia/Gaza')::date,'YYYY-MM');
        v_scopes:=v_scopes||jsonb_build_array(
          jsonb_build_object('tenant_id',v_tenant,'site_id',v_site,'period',v_month));
      END LOOP;
   END IF;
 END LOOP;
 -- One lock order for old and new branches/months; do not take a row lock
 -- before these period locks. This is the same key as C4's period writer.
 FOR v_scope IN
   SELECT DISTINCT s.tenant_id,s.site_id,s.period
   FROM jsonb_to_recordset(v_scopes) AS s(tenant_id bigint,site_id bigint,period text)
   ORDER BY s.tenant_id,s.site_id,s.period
 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended(
      'powerhub:accrual-period:'||v_scope.tenant_id||':'||
        v_scope.site_id||':'||v_scope.period,0));
   IF EXISTS(
      SELECT 1 FROM public.financial_accrual_period_reviews r
      WHERE r.tenant_id=v_scope.tenant_id AND r.site_id=v_scope.site_id
        AND r.period=v_scope.period AND r.status='locked'
   ) THEN
      RAISE EXCEPTION 'D3_ACCRUAL_SOURCE_PERIOD_LOCKED'
         USING ERRCODE='22023';
   END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END;
$guard$;

REVOKE ALL ON FUNCTION public.powerhub_financial_accrual_guard_source_write()
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_financial_accrual_guard_source_write()
 TO service_role;

DROP TRIGGER IF EXISTS d3_accrual_expense_source_guard ON public.expenses;
CREATE TRIGGER d3_accrual_expense_source_guard
BEFORE INSERT OR DELETE OR UPDATE ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_guard_source_write();

DROP TRIGGER IF EXISTS d3_accrual_invoice_source_guard ON public.invoices;
CREATE TRIGGER d3_accrual_invoice_source_guard
BEFORE INSERT OR DELETE OR UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.powerhub_financial_accrual_guard_source_write();

COMMENT ON FUNCTION public.powerhub_financial_accrual_guard_source_write() IS
 'Phase D3: same advisory month lock as C4 for expense and recognized invoice financial source mutations; does NOT certify all operational writers.';
NOTIFY pgrst,'reload schema';
