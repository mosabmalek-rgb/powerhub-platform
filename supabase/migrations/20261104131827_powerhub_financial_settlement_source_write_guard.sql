-- Serialize every mutation that can change the ledger-derived settlement
-- fingerprint with the same tenant/site advisory lock used by settlement approval.
--
-- A source write that obtains the lock first commits before the settlement is
-- fingerprinted. A settlement that obtains it first commits the lock before a
-- later source write can check the relevant accounting date and reject.
--
-- Account transactions are special: the fingerprint includes every movement
-- through period_end because those movements contribute to the opening cash
-- balance, not only movements inside the selected period.

CREATE OR REPLACE FUNCTION public.powerhub_guard_financial_settlement_source_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_scopes jsonb := '[]'::jsonb;
  v_scope record;
  v_link record;
  v_locked boolean;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'payments' THEN
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.id,OLD.tenant_id,OLD.site_id,OLD.amount,OLD.invoice_applied_amount,
                 OLD.subscriber_credit_amount,OLD.payment_purpose,OLD.status,OLD.paid_at)
             IS NOT DISTINCT FROM
             ROW(NEW.id,NEW.tenant_id,NEW.site_id,NEW.amount,NEW.invoice_applied_amount,
                 NEW.subscriber_credit_amount,NEW.payment_purpose,NEW.status,NEW.paid_at) THEN
          RETURN NEW;
        END IF;
      END IF;

      IF TG_OP<>'INSERT' THEN
        IF OLD.status='completed' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',OLD.tenant_id,'site_id',OLD.site_id,
          'guard_mode','timestamp','event_at',OLD.paid_at
        ));
        END IF;
      END IF;
      IF TG_OP<>'DELETE' THEN
        IF NEW.status='completed' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',NEW.tenant_id,'site_id',NEW.site_id,
          'guard_mode','timestamp','event_at',NEW.paid_at
        ));
        END IF;
      END IF;

    WHEN 'expenses' THEN
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.id,OLD.tenant_id,OLD.site_id,OLD.amount,OLD.category,OLD.occurred_at)
             IS NOT DISTINCT FROM
             ROW(NEW.id,NEW.tenant_id,NEW.site_id,NEW.amount,NEW.category,NEW.occurred_at) THEN
          RETURN NEW;
        END IF;
      END IF;

      IF TG_OP<>'INSERT' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',OLD.tenant_id,'site_id',OLD.site_id,
          'guard_mode','timestamp','event_at',OLD.occurred_at
        ));
      END IF;
      IF TG_OP<>'DELETE' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',NEW.tenant_id,'site_id',NEW.site_id,
          'guard_mode','timestamp','event_at',NEW.occurred_at
        ));
      END IF;

    WHEN 'account_transactions' THEN
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.id,OLD.tenant_id,OLD.site_id,OLD.account_id,OLD.transaction_type,
                 OLD.amount,OLD.occurred_at,OLD.related_payment_id,OLD.related_expense_id,
                 OLD.related_supplier_payment_id,OLD.related_supplier_return_id)
             IS NOT DISTINCT FROM
             ROW(NEW.id,NEW.tenant_id,NEW.site_id,NEW.account_id,NEW.transaction_type,
                 NEW.amount,NEW.occurred_at,NEW.related_payment_id,NEW.related_expense_id,
                 NEW.related_supplier_payment_id,NEW.related_supplier_return_id) THEN
          RETURN NEW;
        END IF;
      END IF;

      IF TG_OP<>'INSERT' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',OLD.tenant_id,'site_id',OLD.site_id,
          'guard_mode','account_transaction','event_at',OLD.occurred_at
        ));
      END IF;
      IF TG_OP<>'DELETE' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',NEW.tenant_id,'site_id',NEW.site_id,
          'guard_mode','account_transaction','event_at',NEW.occurred_at
        ));
      END IF;

    WHEN 'supplier_payments' THEN
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.id,OLD.tenant_id,OLD.site_id,OLD.amount,OLD.payment_date,
                 OLD.status,OLD.account_transaction_id)
             IS NOT DISTINCT FROM
             ROW(NEW.id,NEW.tenant_id,NEW.site_id,NEW.amount,NEW.payment_date,
                 NEW.status,NEW.account_transaction_id) THEN
          RETURN NEW;
        END IF;
      END IF;

      IF TG_OP<>'INSERT' THEN
        IF OLD.status='posted' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',OLD.tenant_id,'site_id',OLD.site_id,
          'guard_mode','utc_date','event_date',OLD.payment_date
        ));
        END IF;
      END IF;
      IF TG_OP<>'DELETE' THEN
        IF NEW.status='posted' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',NEW.tenant_id,'site_id',NEW.site_id,
          'guard_mode','utc_date','event_date',NEW.payment_date
        ));
        END IF;
      END IF;

    WHEN 'supplier_purchase_returns' THEN
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.id,OLD.tenant_id,OLD.site_id,OLD.status,OLD.return_date,
                 OLD.total_credit_amount,OLD.refund_amount)
             IS NOT DISTINCT FROM
             ROW(NEW.id,NEW.tenant_id,NEW.site_id,NEW.status,NEW.return_date,
                 NEW.total_credit_amount,NEW.refund_amount) THEN
          RETURN NEW;
        END IF;
      END IF;

      IF TG_OP<>'INSERT' THEN
        IF OLD.status='posted' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',OLD.tenant_id,'site_id',OLD.site_id,
          'guard_mode','utc_date','event_date',OLD.return_date
        ));
        END IF;
      END IF;
      IF TG_OP<>'DELETE' THEN
        IF NEW.status='posted' THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',NEW.tenant_id,'site_id',NEW.site_id,
          'guard_mode','utc_date','event_date',NEW.return_date
        ));
        END IF;
      END IF;

    WHEN 'supplier_purchases' THEN
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.id,OLD.tenant_id,OLD.site_id,OLD.status,OLD.invoice_date,OLD.total_amount)
             IS NOT DISTINCT FROM
             ROW(NEW.id,NEW.tenant_id,NEW.site_id,NEW.status,NEW.invoice_date,NEW.total_amount) THEN
          RETURN NEW;
        END IF;
      END IF;

      IF TG_OP<>'INSERT' THEN
        IF OLD.status IN ('confirmed','partially_received','received') THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',OLD.tenant_id,'site_id',OLD.site_id,
          'guard_mode','utc_date','event_date',OLD.invoice_date
        ));
        END IF;
      END IF;
      IF TG_OP<>'DELETE' THEN
        IF NEW.status IN ('confirmed','partially_received','received') THEN
        v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
          'tenant_id',NEW.tenant_id,'site_id',NEW.site_id,
          'guard_mode','utc_date','event_date',NEW.invoice_date
        ));
        END IF;
      END IF;

    WHEN 'company_accounts' THEN
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.id,OLD.tenant_id,OLD.opening_balance,OLD.created_at)
             IS NOT DISTINCT FROM
             ROW(NEW.id,NEW.tenant_id,NEW.opening_balance,NEW.created_at) THEN
          RETURN NEW;
        END IF;
      END IF;

      IF TG_OP<>'INSERT' THEN
        FOR v_link IN
          SELECT cas.tenant_id,cas.site_id
          FROM public.company_account_sites cas
          WHERE cas.tenant_id=OLD.tenant_id AND cas.account_id=OLD.id
          ORDER BY cas.tenant_id,cas.site_id
        LOOP
          v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
            'tenant_id',v_link.tenant_id,'site_id',v_link.site_id,'guard_mode','all'
          ));
        END LOOP;
      END IF;
      IF TG_OP<>'DELETE' THEN
        FOR v_link IN
          SELECT cas.tenant_id,cas.site_id
          FROM public.company_account_sites cas
          WHERE cas.tenant_id=NEW.tenant_id AND cas.account_id=NEW.id
          ORDER BY cas.tenant_id,cas.site_id
        LOOP
          v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
            'tenant_id',v_link.tenant_id,'site_id',v_link.site_id,'guard_mode','all'
          ));
        END LOOP;
      END IF;

    WHEN 'company_account_sites' THEN
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.tenant_id,OLD.account_id,OLD.site_id)
             IS NOT DISTINCT FROM
             ROW(NEW.tenant_id,NEW.account_id,NEW.site_id) THEN
          RETURN NEW;
        END IF;
      END IF;

      -- The settlement fingerprint records the complete siteIds array for
      -- every linked company account. Changing one link can therefore change
      -- the snapshot of every site linked to that account, not just OLD/NEW.
      IF TG_OP<>'INSERT' THEN
        v_scopes := v_scopes || COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'tenant_id',cas.tenant_id,'site_id',cas.site_id,'guard_mode','all'
          ))
          FROM public.company_account_sites cas
          WHERE cas.tenant_id=OLD.tenant_id AND cas.account_id=OLD.account_id
        ),'[]'::jsonb);
      END IF;
      IF TG_OP<>'DELETE' THEN
        v_scopes := v_scopes || COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'tenant_id',cas.tenant_id,'site_id',cas.site_id,'guard_mode','all'
          ))
          FROM public.company_account_sites cas
          WHERE cas.tenant_id=NEW.tenant_id AND cas.account_id=NEW.account_id
        ),'[]'::jsonb) || jsonb_build_array(jsonb_build_object(
          'tenant_id',NEW.tenant_id,'site_id',NEW.site_id,'guard_mode','all'
        ));
      END IF;

    ELSE
      RAISE EXCEPTION 'FINANCIAL_SETTLEMENT_GUARD_UNSUPPORTED_TABLE: %',TG_TABLE_NAME
        USING ERRCODE='P0001';
  END CASE;

  IF v_scopes='[]'::jsonb THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- Sort all old/new tenant-site scopes before taking advisory locks. This is
  -- important for a row moving between branches and avoids lock-order inversion.
  FOR v_scope IN
    SELECT DISTINCT s.tenant_id,s.site_id,s.guard_mode,s.event_at,s.event_date
    FROM jsonb_to_recordset(v_scopes) AS s(
      tenant_id bigint,site_id bigint,guard_mode text,event_at timestamptz,event_date date
    )
    WHERE s.tenant_id IS NOT NULL AND s.tenant_id>0
      AND s.site_id IS NOT NULL AND s.site_id>0
    ORDER BY s.tenant_id,s.site_id,s.guard_mode,s.event_at NULLS FIRST,s.event_date NULLS FIRST
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'powerhub-financial-settlement-site:'||
        v_scope.tenant_id::text||':'||v_scope.site_id::text,0
    ));

    IF v_scope.guard_mode='timestamp' THEN
      SELECT EXISTS(
        SELECT 1 FROM public.financial_settlements fs
        WHERE fs.tenant_id=v_scope.tenant_id AND fs.site_id=v_scope.site_id
          AND fs.status='locked'
          AND fs.period_start<=v_scope.event_at
          AND fs.period_end>=v_scope.event_at
      ) INTO v_locked;
    ELSIF v_scope.guard_mode='account_transaction' THEN
      -- Every prior cash movement is part of the opening cash balance.
      SELECT EXISTS(
        SELECT 1 FROM public.financial_settlements fs
        WHERE fs.tenant_id=v_scope.tenant_id AND fs.site_id=v_scope.site_id
          AND fs.status='locked'
          AND fs.period_end>=v_scope.event_at
      ) INTO v_locked;
    ELSIF v_scope.guard_mode='utc_date' THEN
      SELECT EXISTS(
        SELECT 1 FROM public.financial_settlements fs
        WHERE fs.tenant_id=v_scope.tenant_id AND fs.site_id=v_scope.site_id
          AND fs.status='locked'
          AND (fs.period_start AT TIME ZONE 'UTC')::date<=v_scope.event_date
          AND (fs.period_end AT TIME ZONE 'UTC')::date>=v_scope.event_date
      ) INTO v_locked;
    ELSIF v_scope.guard_mode='all' THEN
      SELECT EXISTS(
        SELECT 1 FROM public.financial_settlements fs
        WHERE fs.tenant_id=v_scope.tenant_id AND fs.site_id=v_scope.site_id
          AND fs.status='locked'
      ) INTO v_locked;
    ELSE
      RAISE EXCEPTION 'FINANCIAL_SETTLEMENT_GUARD_INVALID_MODE: %',v_scope.guard_mode
        USING ERRCODE='P0001';
    END IF;

    IF v_locked THEN
      RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCKED' USING ERRCODE='P0001';
    END IF;
  END LOOP;

  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_guard_financial_settlement_source_write()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_guard_financial_settlement_source_write()
  TO service_role;

DROP TRIGGER IF EXISTS zz_powerhub_financial_settlement_source_write_guard ON public.payments;
CREATE TRIGGER zz_powerhub_financial_settlement_source_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_financial_settlement_source_write();

DROP TRIGGER IF EXISTS zz_powerhub_financial_settlement_source_write_guard ON public.expenses;
CREATE TRIGGER zz_powerhub_financial_settlement_source_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_financial_settlement_source_write();

-- Name sorts after account_transactions_resolve_site_before_write so the
-- branch scope is populated before the settlement guard evaluates the row.
DROP TRIGGER IF EXISTS zz_powerhub_financial_settlement_source_write_guard ON public.account_transactions;
CREATE TRIGGER zz_powerhub_financial_settlement_source_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.account_transactions
  FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_financial_settlement_source_write();

DROP TRIGGER IF EXISTS zz_powerhub_financial_settlement_source_write_guard ON public.supplier_payments;
CREATE TRIGGER zz_powerhub_financial_settlement_source_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_financial_settlement_source_write();

DROP TRIGGER IF EXISTS zz_powerhub_financial_settlement_source_write_guard ON public.supplier_purchase_returns;
CREATE TRIGGER zz_powerhub_financial_settlement_source_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_purchase_returns
  FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_financial_settlement_source_write();

DROP TRIGGER IF EXISTS zz_powerhub_financial_settlement_source_write_guard ON public.supplier_purchases;
CREATE TRIGGER zz_powerhub_financial_settlement_source_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_purchases
  FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_financial_settlement_source_write();

DROP TRIGGER IF EXISTS zz_powerhub_financial_settlement_source_write_guard ON public.company_accounts;
CREATE TRIGGER zz_powerhub_financial_settlement_source_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_accounts
  FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_financial_settlement_source_write();

DROP TRIGGER IF EXISTS zz_powerhub_financial_settlement_source_write_guard ON public.company_account_sites;
CREATE TRIGGER zz_powerhub_financial_settlement_source_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_account_sites
  FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_financial_settlement_source_write();

COMMENT ON FUNCTION public.powerhub_guard_financial_settlement_source_write() IS
  'Serializes changes to ledger-derived settlement sources with the tenant/site settlement lock and rejects writes into locked accounting periods.';

-- These RPCs accept an explicit historical business date. Do not reject them
-- merely because the wall-clock date falls in a different locked period. The
-- source-write triggers above also check the actual account-transaction date
-- when a reversal or refund creates a current cash movement.
DO $date_guards$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  IF to_regprocedure('public.powerhub_inventory_cancel_purchase(bigint,bigint,bigint,bigint,text)') IS NOT NULL THEN
    v_definition:=pg_get_functiondef('public.powerhub_inventory_cancel_purchase(bigint,bigint,bigint,bigint,text)'::regprocedure);
    v_old:=$old$and (
        (fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_purchase.invoice_date and fs.period_end::date>=v_purchase.invoice_date)
      )$old$;
    v_new:=$new$and fs.period_start::date<=v_purchase.invoice_date
      and fs.period_end::date>=v_purchase.invoice_date$new$;
    IF position(v_old IN v_definition)=0 THEN
      RAISE EXCEPTION 'SETTLEMENT_DATE_GUARD_PATCH_NOT_FOUND: powerhub_inventory_cancel_purchase';
    END IF;
    EXECUTE replace(v_definition,v_old,v_new);
  END IF;

  IF to_regprocedure('public.powerhub_inventory_return_to_supplier(bigint,bigint,bigint,bigint,date,text,text,text,jsonb,numeric,bigint)') IS NOT NULL THEN
    v_definition:=pg_get_functiondef('public.powerhub_inventory_return_to_supplier(bigint,bigint,bigint,bigint,date,text,text,text,jsonb,numeric,bigint)'::regprocedure);
    v_old:=$old$and (
        (fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_return_date and fs.period_end::date>=v_return_date)
      )$old$;
    v_new:=$new$and fs.period_start::date<=v_return_date
      and fs.period_end::date>=v_return_date$new$;
    IF position(v_old IN v_definition)=0 THEN
      RAISE EXCEPTION 'SETTLEMENT_DATE_GUARD_PATCH_NOT_FOUND: powerhub_inventory_return_to_supplier';
    END IF;
    EXECUTE replace(v_definition,v_old,v_new);
  END IF;

  IF to_regprocedure('public.powerhub_inventory_reverse_supplier_payment(bigint,bigint,bigint,bigint,text)') IS NOT NULL THEN
    v_definition:=pg_get_functiondef('public.powerhub_inventory_reverse_supplier_payment(bigint,bigint,bigint,bigint,text)'::regprocedure);
    v_old:=$old$and (
          (fs.period_start<=now() and fs.period_end>=now())
          or (fs.period_start::date<=v_payment.payment_date and fs.period_end::date>=v_payment.payment_date)
        )$old$;
    v_new:=$new$and fs.period_start::date<=v_payment.payment_date
          and fs.period_end::date>=v_payment.payment_date$new$;
    IF position(v_old IN v_definition)=0 THEN
      RAISE EXCEPTION 'SETTLEMENT_DATE_GUARD_PATCH_NOT_FOUND: powerhub_inventory_reverse_supplier_payment';
    END IF;
    EXECUTE replace(v_definition,v_old,v_new);
  END IF;

  IF to_regprocedure('public.powerhub_inventory_reverse_supplier_payment_flexible(bigint,bigint,bigint,bigint,text)') IS NOT NULL THEN
    v_definition:=pg_get_functiondef('public.powerhub_inventory_reverse_supplier_payment_flexible(bigint,bigint,bigint,bigint,text)'::regprocedure);
    v_old:=$old$and ((fs.period_start<=now() and fs.period_end>=now())
          or (fs.period_start::date<=v_payment.payment_date and fs.period_end::date>=v_payment.payment_date))$old$;
    v_new:=$new$and fs.period_start::date<=v_payment.payment_date
          and fs.period_end::date>=v_payment.payment_date$new$;
    IF position(v_old IN v_definition)=0 THEN
      RAISE EXCEPTION 'SETTLEMENT_DATE_GUARD_PATCH_NOT_FOUND: powerhub_inventory_reverse_supplier_payment_flexible';
    END IF;
    EXECUTE replace(v_definition,v_old,v_new);
  END IF;
END
$date_guards$;
