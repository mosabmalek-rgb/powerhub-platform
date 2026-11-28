-- Separate operational item category from its accounting treatment.
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS accounting_treatment text NOT NULL DEFAULT 'pending_classification';

UPDATE public.inventory_items
SET accounting_treatment='expense_on_issue'
WHERE category IN ('fuel','oil','filter','spare_part','maintenance_supply')
  AND accounting_treatment='pending_classification';

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_accounting_treatment_check;
ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_accounting_treatment_check
  CHECK (accounting_treatment IN ('expense_on_issue','capital_asset','pending_classification'));

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_fuel_accounting_treatment_check;
ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_fuel_accounting_treatment_check
  CHECK (category<>'fuel' OR accounting_treatment='expense_on_issue');

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_capital_asset_category_check;
ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_capital_asset_category_check
  CHECK (accounting_treatment<>'capital_asset' OR category='other');

COMMENT ON COLUMN public.inventory_items.accounting_treatment IS
  'expense_on_issue: P&L expense when issued; capital_asset: only for category=other, excluded from P&L and reported separately; pending_classification: only for category=other and blocks settlement when issued.';

CREATE OR REPLACE FUNCTION public.powerhub_inventory_set_default_accounting_treatment()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp
AS $function$
BEGIN
  IF NEW.category<>'other' AND NEW.accounting_treatment='pending_classification' THEN
    NEW.accounting_treatment:='expense_on_issue';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS powerhub_inventory_item_accounting_defaults ON public.inventory_items;
CREATE TRIGGER powerhub_inventory_item_accounting_defaults
BEFORE INSERT OR UPDATE OF category,accounting_treatment ON public.inventory_items
FOR EACH ROW EXECUTE FUNCTION public.powerhub_inventory_set_default_accounting_treatment();
CREATE OR REPLACE FUNCTION public.powerhub_guard_inventory_item_accounting_treatment_write()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp
AS $function$
DECLARE v_scope record;
BEGIN
  IF NEW.accounting_treatment IS NOT DISTINCT FROM OLD.accounting_treatment THEN RETURN NEW; END IF;
  FOR v_scope IN
    SELECT DISTINCT m.tenant_id,m.site_id,m.occurred_at
    FROM public.inventory_stock_movements m
    WHERE m.tenant_id=OLD.tenant_id AND m.item_id=OLD.id
    ORDER BY m.tenant_id,m.site_id,m.occurred_at
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'powerhub-financial-settlement-site:'||v_scope.tenant_id::text||':'||v_scope.site_id::text,0
    ));
    IF EXISTS(
      SELECT 1 FROM public.financial_settlements fs
      WHERE fs.tenant_id=v_scope.tenant_id AND fs.site_id=v_scope.site_id
        AND fs.status='locked' AND fs.period_start<=v_scope.occurred_at
        AND fs.period_end>=v_scope.occurred_at
    ) THEN RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCKED' USING ERRCODE='P0001'; END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS powerhub_inventory_item_accounting_lock_guard ON public.inventory_items;
CREATE TRIGGER powerhub_inventory_item_accounting_lock_guard
BEFORE UPDATE OF accounting_treatment ON public.inventory_items
FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_inventory_item_accounting_treatment_write();
create or replace function public.powerhub_inventory_create_item_v2(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_sku text,
  p_name text,
  p_category text,
  p_base_unit text,
  p_reorder_point numeric,
  p_specification text,
  p_notes text,
  p_accounting_treatment text
)
returns table(
  id bigint, tenant_id bigint, sku text, name text, category text, base_unit text,
  reorder_point numeric, specification text, notes text, accounting_treatment text, is_active boolean,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_item public.inventory_items%rowtype;
  v_platform_role text;
begin
  if p_accounting_treatment not in ('expense_on_issue','capital_asset','pending_classification') then
    raise exception 'INVALID_INVENTORY_ACCOUNTING_TREATMENT' using errcode='P0001';
  end if;
  if p_category='fuel' and p_accounting_treatment<>'expense_on_issue' then
    raise exception 'FUEL_MUST_BE_EXPENSED_ON_ISSUE' using errcode='P0001';
  end if;
  if p_accounting_treatment in ('capital_asset','pending_classification') and p_category<>'other' then
    raise exception 'NON_OTHER_ITEM_REQUIRES_OPERATING_EXPENSE_TREATMENT' using errcode='P0001';
  end if;
  perform 1 from public.sites as s where s.id=p_site_id and s.tenant_id=p_tenant_id;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role from public.users as u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.inventory_items(
    tenant_id,sku,name,category,base_unit,reorder_point,specification,notes,accounting_treatment,created_by_user_id
  ) values (
    p_tenant_id,nullif(btrim(p_sku),''),btrim(p_name),p_category,p_base_unit,
    p_reorder_point,nullif(btrim(p_specification),''),nullif(btrim(p_notes),''),p_accounting_treatment,p_user_id
  ) returning * into v_item;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_item',v_item.id::text,'create',
    jsonb_build_object('sku',v_item.sku,'name',v_item.name,'category',v_item.category,'baseUnit',v_item.base_unit,'accountingTreatment',v_item.accounting_treatment)
  );

  return query select v_item.id,v_item.tenant_id,v_item.sku,v_item.name,v_item.category,v_item.base_unit,
    v_item.reorder_point,v_item.specification,v_item.notes,v_item.accounting_treatment,v_item.is_active,v_item.created_at,v_item.updated_at;
end;
$$;
CREATE OR REPLACE FUNCTION public.powerhub_inventory_create_item(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_sku text,p_name text,
  p_category text,p_base_unit text,p_reorder_point numeric,p_specification text,p_notes text
)
RETURNS TABLE(
  id bigint,tenant_id bigint,sku text,name text,category text,base_unit text,
  reorder_point numeric,specification text,notes text,is_active boolean,
  created_at timestamptz,updated_at timestamptz
)
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp
AS $function$
  SELECT id,tenant_id,sku,name,category,base_unit,reorder_point,specification,notes,is_active,created_at,updated_at
  FROM public.powerhub_inventory_create_item_v2(
    p_tenant_id,p_site_id,p_user_id,p_sku,p_name,p_category,p_base_unit,p_reorder_point,
    p_specification,p_notes,
    CASE WHEN p_category='other' THEN 'pending_classification' ELSE 'expense_on_issue' END
  );
$function$;
create or replace function public.powerhub_inventory_update_item_v2(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_item_id bigint,
  p_sku text, p_name text, p_category text, p_base_unit text, p_reorder_point numeric,
  p_specification text, p_notes text, p_accounting_treatment text
)
returns table(
  id bigint, tenant_id bigint, sku text, name text, category text, base_unit text,
  reorder_point numeric, specification text, notes text, accounting_treatment text, is_active boolean,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_item public.inventory_items%rowtype;
  v_before jsonb;
  v_platform_role text;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 180
    or p_category not in ('fuel','oil','filter','spare_part','maintenance_supply','other')
    or p_base_unit not in ('liter','milliliter','piece','container','kg','gram','meter','set','gallon','other')
    or p_reorder_point is null or p_reorder_point<0
    or p_accounting_treatment not in ('expense_on_issue','capital_asset','pending_classification')
    or (p_category='fuel' and p_accounting_treatment<>'expense_on_issue')
    or (p_accounting_treatment in ('capital_asset','pending_classification') and p_category<>'other') then
    raise exception 'INVALID_INVENTORY_ITEM' using errcode='P0001';
  end if;
  select i.* into v_item from public.inventory_items i
  where i.tenant_id=p_tenant_id and i.id=p_item_id for update;
  if not found then raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode='P0001'; end if;

  if p_base_unit is distinct from v_item.base_unit and (
    exists(select 1 from public.inventory_stock_movements m where m.tenant_id=p_tenant_id and m.item_id=p_item_id)
    or exists(select 1 from public.supplier_purchase_lines l where l.tenant_id=p_tenant_id and l.item_id=p_item_id)
  ) then
    raise exception 'ITEM_BASE_UNIT_IMMUTABLE_AFTER_USE' using errcode='P0001';
  end if;
  if (
    p_sku is distinct from v_item.sku
    or btrim(p_name) is distinct from v_item.name
    or p_category is distinct from v_item.category
  ) and (
    exists(select 1 from public.inventory_stock_movements m where m.tenant_id=p_tenant_id and m.item_id=p_item_id)
    or exists(select 1 from public.supplier_purchase_lines l where l.tenant_id=p_tenant_id and l.item_id=p_item_id)
  ) then
    raise exception 'ITEM_IDENTITY_IMMUTABLE_AFTER_USE' using errcode='P0001';
  end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  v_before:=jsonb_build_object(
    'sku',v_item.sku,'name',v_item.name,'category',v_item.category,'baseUnit',v_item.base_unit,
    'reorderPoint',v_item.reorder_point,'specification',v_item.specification,'notes',v_item.notes,
    'accountingTreatment',v_item.accounting_treatment
  );

  update public.inventory_items i set
    sku=nullif(btrim(p_sku),''),name=btrim(p_name),category=p_category,base_unit=p_base_unit,
    reorder_point=p_reorder_point,specification=nullif(btrim(p_specification),''),
    notes=nullif(btrim(p_notes),''),accounting_treatment=p_accounting_treatment,updated_at=now()
  where i.tenant_id=p_tenant_id and i.id=p_item_id returning i.* into v_item;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_item',v_item.id::text,'update',v_before,
    jsonb_build_object('sku',v_item.sku,'name',v_item.name,'category',v_item.category,'baseUnit',v_item.base_unit,
      'reorderPoint',v_item.reorder_point,'specification',v_item.specification,'notes',v_item.notes,
      'accountingTreatment',v_item.accounting_treatment)
  );
  return query select v_item.id,v_item.tenant_id,v_item.sku,v_item.name,v_item.category,v_item.base_unit,
    v_item.reorder_point,v_item.specification,v_item.notes,v_item.accounting_treatment,v_item.is_active,v_item.created_at,v_item.updated_at;
end;
$$;
CREATE OR REPLACE FUNCTION public.powerhub_inventory_update_item(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_item_id bigint,
  p_sku text,p_name text,p_category text,p_base_unit text,p_reorder_point numeric,
  p_specification text,p_notes text
)
RETURNS TABLE(
  id bigint,tenant_id bigint,sku text,name text,category text,base_unit text,
  reorder_point numeric,specification text,notes text,is_active boolean,
  created_at timestamptz,updated_at timestamptz
)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp
AS $function$
DECLARE v_treatment text;
BEGIN
  SELECT accounting_treatment INTO v_treatment
  FROM public.inventory_items WHERE tenant_id=p_tenant_id AND id=p_item_id;
  RETURN QUERY
  SELECT id,tenant_id,sku,name,category,base_unit,reorder_point,specification,notes,is_active,created_at,updated_at
  FROM public.powerhub_inventory_update_item_v2(
    p_tenant_id,p_site_id,p_user_id,p_item_id,p_sku,p_name,p_category,p_base_unit,
    p_reorder_point,p_specification,p_notes,
    COALESCE(v_treatment,CASE WHEN p_category='other' THEN 'pending_classification' ELSE 'expense_on_issue' END)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_inventory_create_item_v2(bigint,bigint,bigint,text,text,text,text,numeric,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_inventory_create_item_v2(bigint,bigint,bigint,text,text,text,text,numeric,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.powerhub_inventory_update_item_v2(bigint,bigint,bigint,bigint,text,text,text,text,numeric,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_inventory_update_item_v2(bigint,bigint,bigint,bigint,text,text,text,text,numeric,text,text,text) TO service_role;

-- Include non-cash inventory issues in operating profit and settlement snapshots.
-- A fuel fill creates one fuel_consumption issue; material returns reverse their
-- original issue cost. Supplier payments remain cash-only and are not P&L expense.
CREATE OR REPLACE FUNCTION public.powerhub_financial_settlement_preview(p_tenant_id bigint, p_site_id bigint, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total_collected numeric(14,2) := 0;
  v_total_expenses numeric(14,2) := 0;
  v_inventory_consumption_cost numeric(14,2) := 0;
  v_inventory_expenses_by_category jsonb := '{}'::jsonb;
  v_inventory_capital_asset_issue_cost numeric(14,2) := 0;
  v_unclassified_inventory_movement_count bigint := 0;
  v_book_profit numeric(14,2) := 0;
  v_subscriber_credit_created numeric(14,2) := 0;
  v_security_deposit_received numeric(14,2) := 0;
  v_security_deposit_refunded numeric(14,2) := 0;
  v_supplier_payment_amount numeric(14,2) := 0;
  v_supplier_purchase_invoice_amount numeric(14,2) := 0;
  v_supplier_return_credit_amount numeric(14,2) := 0;
  v_supplier_return_refund_amount numeric(14,2) := 0;
  v_cash_opening_balance numeric(14,2) := 0;
  v_account_opening_balance_added numeric(14,2) := 0;
  v_unallocated_shared_opening_balance numeric(14,2) := 0;
  v_cash_transaction_inflows numeric(14,2) := 0;
  v_cash_transaction_outflows numeric(14,2) := 0;
  v_cash_inflows numeric(14,2) := 0;
  v_cash_outflows numeric(14,2) := 0;
  v_book_cash_balance numeric(14,2);
  v_collection_cash numeric(14,2) := 0;
  v_other_collection_cash numeric(14,2) := 0;
  v_deposit_cash numeric(14,2) := 0;
  v_security_deposit_cash_in numeric(14,2) := 0;
  v_supplier_return_cash_in numeric(14,2) := 0;
  v_other_deposit_cash numeric(14,2) := 0;
  v_transfer_in_cash numeric(14,2) := 0;
  v_expense_cash_out numeric(14,2) := 0;
  v_supplier_payment_cash_out numeric(14,2) := 0;
  v_security_deposit_refund_cash_out numeric(14,2) := 0;
  v_other_payment_cash_out numeric(14,2) := 0;
  v_other_withdrawal_cash numeric(14,2) := 0;
  v_transfer_out_cash numeric(14,2) := 0;
  v_payment_cash_mismatch_count bigint := 0;
  v_expense_cash_mismatch_count bigint := 0;
  v_supplier_payment_cash_mismatch_count bigint := 0;
  v_supplier_return_cash_mismatch_count bigint := 0;
  v_unlinked_account_movement_count bigint := 0;
  v_orphan_reference_movement_count bigint := 0;
  v_operating_expenses_by_category jsonb := '{}'::jsonb;
  v_cash_balance_complete boolean := false;
  v_is_reconciled boolean := false;
  v_integrity_issue_count bigint := 0;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id < 1
     OR p_site_id IS NULL OR p_site_id < 1
     OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_start >= p_period_end THEN
    RAISE EXCEPTION 'INVALID_SETTLEMENT_PERIOD' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sites s
    WHERE s.tenant_id = p_tenant_id
      AND s.id = p_site_id
      AND s.status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'SITE_OUT_OF_SCOPE' USING ERRCODE = 'P0001';
  END IF;

  -- Profit-side collections: the part applied to an invoice only.
  SELECT
    COALESCE(SUM(
      CASE WHEN p.payment_purpose IN ('invoice_collection','invoice_collection_with_credit')
        THEN p.invoice_applied_amount ELSE 0 END
    ),0)::numeric(14,2),
    COALESCE(SUM(
      CASE WHEN p.payment_purpose IN ('invoice_collection_with_credit','subscriber_credit')
        THEN p.subscriber_credit_amount ELSE 0 END
    ),0)::numeric(14,2),
    COALESCE(SUM(CASE WHEN p.payment_purpose='security_deposit' THEN p.amount ELSE 0 END),0)::numeric(14,2),
    COALESCE(SUM(CASE WHEN p.payment_purpose='security_deposit_refund' THEN p.amount ELSE 0 END),0)::numeric(14,2)
  INTO
    v_total_collected,
    v_subscriber_credit_created,
    v_security_deposit_received,
    v_security_deposit_refunded
  FROM public.payments p
  WHERE p.tenant_id = p_tenant_id
    AND p.site_id = p_site_id
    AND p.status = 'completed'
    AND p.paid_at >= p_period_start
    AND p.paid_at <= p_period_end;

  -- Only explicitly classified operating consumables become P&L expenses.
  -- Capital assets are exposed separately; pending issues prevent settlement.
  WITH effective_movements AS (
    SELECT m.id,m.item_id,m.movement_type,m.quantity,m.total_cost_amount,m.occurred_at,
      i.category,i.accounting_treatment,
      CASE WHEN m.movement_type='return_from_issue' THEN -m.total_cost_amount ELSE m.total_cost_amount END AS signed_cost
    FROM public.inventory_stock_movements m
    JOIN public.inventory_items i ON i.tenant_id=m.tenant_id AND i.id=m.item_id
    WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
      AND m.movement_type IN ('issue','fuel_consumption','return_from_issue')
      AND m.occurred_at>=p_period_start AND m.occurred_at<=p_period_end
      AND (
        m.movement_type='return_from_issue'
        OR NOT EXISTS (
          SELECT 1 FROM public.inventory_stock_movements reversal
          WHERE reversal.tenant_id=m.tenant_id AND reversal.site_id=m.site_id
            AND reversal.reversal_of_movement_id=m.id
        )
      )
      AND (
        m.movement_type<>'return_from_issue'
        OR EXISTS (
          SELECT 1 FROM public.inventory_stock_movements source
          WHERE source.tenant_id=m.tenant_id AND source.site_id=m.site_id
            AND source.id=m.source_issue_movement_id AND source.movement_type='issue'
            AND source.occurred_at<=m.occurred_at
            AND NOT EXISTS (
              SELECT 1 FROM public.inventory_stock_movements reversal
              WHERE reversal.tenant_id=source.tenant_id AND reversal.site_id=source.site_id
                AND reversal.reversal_of_movement_id=source.id
            )
        )
      )
  )
  SELECT
    COALESCE(SUM(signed_cost) FILTER (
      WHERE accounting_treatment='expense_on_issue'
        AND ((category='fuel' AND movement_type='fuel_consumption')
          OR (category<>'fuel' AND movement_type IN ('issue','return_from_issue')))
    ),0)::numeric(14,2),
    COALESCE(SUM(signed_cost) FILTER (
      WHERE accounting_treatment='capital_asset'
        AND movement_type IN ('issue','return_from_issue')
    ),0)::numeric(14,2),
    COUNT(*) FILTER (WHERE accounting_treatment='pending_classification')::bigint
  INTO v_inventory_consumption_cost,v_inventory_capital_asset_issue_cost,
       v_unclassified_inventory_movement_count
  FROM effective_movements;

  SELECT COALESCE(SUM(e.amount),0)::numeric(14,2)
  INTO v_total_expenses
  FROM public.expenses e
  WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
    AND e.occurred_at>=p_period_start AND e.occurred_at<=p_period_end;

  WITH manual_by_category AS (
    SELECT e.category,SUM(e.amount)::numeric(14,2) amount
    FROM public.expenses e
    WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
      AND e.occurred_at>=p_period_start AND e.occurred_at<=p_period_end
    GROUP BY e.category
  ), inventory_by_category AS (
    SELECT
      CASE
        WHEN i.category='fuel' THEN 'fuel'
        WHEN i.category IN ('oil','filter','maintenance_supply') THEN 'maintenance'
        WHEN i.category='spare_part' THEN 'parts'
        WHEN i.category='other' THEN 'other'
        ELSE 'other'
      END AS category,
      SUM(CASE WHEN m.movement_type='return_from_issue' THEN -m.total_cost_amount ELSE m.total_cost_amount END)::numeric(14,2) amount
    FROM public.inventory_stock_movements m
    JOIN public.inventory_items i ON i.tenant_id=m.tenant_id AND i.id=m.item_id
    WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
      AND i.accounting_treatment='expense_on_issue'
      AND ((i.category='fuel' AND m.movement_type='fuel_consumption')
        OR (i.category<>'fuel' AND m.movement_type IN ('issue','return_from_issue')))
      AND m.occurred_at>=p_period_start AND m.occurred_at<=p_period_end
      AND (
        m.movement_type='return_from_issue'
        OR NOT EXISTS (
          SELECT 1 FROM public.inventory_stock_movements reversal
          WHERE reversal.tenant_id=m.tenant_id AND reversal.site_id=m.site_id
            AND reversal.reversal_of_movement_id=m.id
        )
      )
      AND (
        m.movement_type<>'return_from_issue'
        OR EXISTS (
          SELECT 1 FROM public.inventory_stock_movements source
          WHERE source.tenant_id=m.tenant_id AND source.site_id=m.site_id
            AND source.id=m.source_issue_movement_id AND source.movement_type='issue'
            AND source.occurred_at<=m.occurred_at
            AND NOT EXISTS (
              SELECT 1 FROM public.inventory_stock_movements reversal
              WHERE reversal.tenant_id=source.tenant_id AND reversal.site_id=source.site_id
                AND reversal.reversal_of_movement_id=source.id
            )
        )
      )
    GROUP BY 1
  ), all_categories AS (
    SELECT category,amount FROM manual_by_category
    UNION ALL
    SELECT category,amount FROM inventory_by_category
  ), merged_categories AS (
    SELECT category,SUM(amount)::numeric(14,2) amount
    FROM all_categories GROUP BY category
  )
  SELECT COALESCE(jsonb_object_agg(category,amount),'{}'::jsonb)
  INTO v_operating_expenses_by_category
  FROM merged_categories;

  v_total_expenses:=round(v_total_expenses+v_inventory_consumption_cost,2);
  v_book_profit:=round(v_total_collected-v_total_expenses,2);

  -- Source-to-cash checks prevent a profit or cash snapshot from hiding
  -- completed payments, expenses or supplier settlements that lack their
  -- corresponding company-account movement.
  SELECT count(*)::bigint
  INTO v_payment_cash_mismatch_count
  FROM public.payments p
  WHERE p.tenant_id = p_tenant_id
    AND p.site_id = p_site_id
    AND p.status = 'completed'
    AND p.paid_at >= p_period_start
    AND p.paid_at <= p_period_end
    AND (
      (SELECT count(*) FROM public.account_transactions t
        WHERE t.tenant_id=p.tenant_id AND t.site_id=p.site_id AND t.related_payment_id=p.id) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM public.account_transactions t
        WHERE t.tenant_id=p.tenant_id AND t.site_id=p.site_id
          AND t.related_payment_id=p.id
          AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
          AND t.amount=p.amount
          AND t.transaction_type=CASE
            WHEN p.payment_purpose='security_deposit' THEN 'deposit'
            WHEN p.payment_purpose='security_deposit_refund' THEN 'withdrawal'
            ELSE 'collection'
          END
      )
    );

  SELECT count(*)::bigint
  INTO v_expense_cash_mismatch_count
  FROM public.expenses e
  WHERE e.tenant_id = p_tenant_id
    AND e.site_id = p_site_id
    AND e.occurred_at >= p_period_start
    AND e.occurred_at <= p_period_end
    AND (
      (SELECT count(*) FROM public.account_transactions t
        WHERE t.tenant_id=e.tenant_id AND t.site_id=e.site_id AND t.related_expense_id=e.id) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM public.account_transactions t
        WHERE t.tenant_id=e.tenant_id AND t.site_id=e.site_id
          AND t.related_expense_id=e.id
          AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
          AND t.transaction_type='withdrawal' AND t.amount=e.amount
      )
    );

  SELECT
    (
      SELECT count(*)::bigint
      FROM public.supplier_payments sp
      WHERE sp.tenant_id = p_tenant_id
        AND sp.site_id = p_site_id
        AND sp.status = 'posted'
        AND sp.payment_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND sp.payment_date <= (p_period_end AT TIME ZONE 'UTC')::date
        AND (
          (SELECT count(*) FROM public.account_transactions t
            WHERE t.tenant_id=sp.tenant_id AND t.site_id=sp.site_id AND t.related_supplier_payment_id=sp.id) <> 1
          OR NOT EXISTS (
            SELECT 1 FROM public.account_transactions t
            WHERE t.id=sp.account_transaction_id AND t.tenant_id=sp.tenant_id AND t.site_id=sp.site_id
              AND t.related_supplier_payment_id=sp.id
              AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
              AND t.transaction_type='withdrawal' AND t.amount=sp.amount
          )
        )
    )::bigint,
    (
      SELECT COALESCE(SUM(sp.amount),0)::numeric(14,2)
      FROM public.supplier_payments sp
      WHERE sp.tenant_id = p_tenant_id
        AND sp.site_id = p_site_id
        AND sp.status = 'posted'
        AND sp.payment_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND sp.payment_date <= (p_period_end AT TIME ZONE 'UTC')::date
    )
  INTO v_supplier_payment_cash_mismatch_count, v_supplier_payment_amount;

  SELECT
    (
      SELECT count(*)::bigint
      FROM public.supplier_purchase_returns r
      WHERE r.tenant_id = p_tenant_id
        AND r.site_id = p_site_id
        AND r.status = 'posted'
        AND r.return_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND r.return_date <= (p_period_end AT TIME ZONE 'UTC')::date
        AND r.refund_amount > 0
        AND (
          (SELECT count(*) FROM public.account_transactions t
            WHERE t.tenant_id=r.tenant_id AND t.site_id=r.site_id AND t.related_supplier_return_id=r.id) <> 1
          OR NOT EXISTS (
            SELECT 1 FROM public.account_transactions t
            WHERE t.tenant_id=r.tenant_id AND t.site_id=r.site_id
              AND t.related_supplier_return_id=r.id
              AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
              AND t.transaction_type='deposit' AND t.amount=r.refund_amount
          )
        )
    )::bigint,
    (
      SELECT COALESCE(SUM(r.total_credit_amount),0)::numeric(14,2)
      FROM public.supplier_purchase_returns r
      WHERE r.tenant_id = p_tenant_id
        AND r.site_id = p_site_id
        AND r.status = 'posted'
        AND r.return_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND r.return_date <= (p_period_end AT TIME ZONE 'UTC')::date
    ),
    (
      SELECT COALESCE(SUM(r.refund_amount),0)::numeric(14,2)
      FROM public.supplier_purchase_returns r
      WHERE r.tenant_id = p_tenant_id
        AND r.site_id = p_site_id
        AND r.status = 'posted'
        AND r.return_date >= (p_period_start AT TIME ZONE 'UTC')::date
        AND r.return_date <= (p_period_end AT TIME ZONE 'UTC')::date
    )
  INTO v_supplier_return_cash_mismatch_count,
       v_supplier_return_credit_amount,
       v_supplier_return_refund_amount;

  SELECT COALESCE(SUM(p.total_amount),0)::numeric(14,2)
  INTO v_supplier_purchase_invoice_amount
  FROM public.supplier_purchases p
  WHERE p.tenant_id = p_tenant_id
    AND p.site_id = p_site_id
    AND p.invoice_date >= (p_period_start AT TIME ZONE 'UTC')::date
    AND p.invoice_date <= (p_period_end AT TIME ZONE 'UTC')::date
    AND p.status IN ('confirmed','partially_received','received');

  -- Attribute account opening balances only when the account belongs to one site.
  -- Non-zero opening balances on shared accounts are unallocated and block reconciliation.
  WITH account_scopes AS (
    SELECT
      ca.id,
      ca.opening_balance,
      ca.created_at,
      count(DISTINCT cas.site_id)::bigint AS linked_site_count,
      COALESCE(bool_or(cas.site_id = p_site_id),false) AS belongs_to_site
    FROM public.company_accounts ca
    LEFT JOIN public.company_account_sites cas
      ON cas.tenant_id = ca.tenant_id
     AND cas.account_id = ca.id
    WHERE ca.tenant_id = p_tenant_id
    GROUP BY ca.id,ca.opening_balance,ca.created_at
  )
  SELECT
    COALESCE(SUM(
      CASE WHEN linked_site_count=1 AND created_at < p_period_start
        THEN opening_balance ELSE 0 END
    ),0)::numeric(14,2),
    COALESCE(SUM(
      CASE WHEN linked_site_count=1
        AND created_at >= p_period_start AND created_at <= p_period_end
        THEN opening_balance ELSE 0 END
    ),0)::numeric(14,2),
    COALESCE(SUM(
      CASE WHEN linked_site_count<>1 AND created_at <= p_period_end
        THEN abs(opening_balance) ELSE 0 END
    ),0)::numeric(14,2)
  INTO
    v_cash_opening_balance,
    v_account_opening_balance_added,
    v_unallocated_shared_opening_balance
  FROM account_scopes
  WHERE belongs_to_site OR linked_site_count=0;

  SELECT v_cash_opening_balance + COALESCE(SUM(
    CASE WHEN t.transaction_type IN ('deposit','transfer_in','collection')
      THEN t.amount ELSE -t.amount END
  ),0)::numeric(14,2)
  INTO v_cash_opening_balance
  FROM public.account_transactions t
  WHERE t.tenant_id = p_tenant_id
    AND t.site_id = p_site_id
    AND t.occurred_at < p_period_start;

  -- Period cash movements are independent of operating profit. Transfers
  -- affect branch cash only when they cross the selected branch boundary.
  SELECT
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type IN ('deposit','transfer_in','collection')),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type IN ('withdrawal','transfer_out')),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='collection' AND EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.tenant_id=t.tenant_id AND p.site_id=t.site_id
          AND p.id=t.related_payment_id AND p.status='completed'
          AND p.payment_purpose IN ('invoice_collection','invoice_collection_with_credit','subscriber_credit')
      )
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='collection' AND NOT EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.tenant_id=t.tenant_id AND p.site_id=t.site_id
          AND p.id=t.related_payment_id AND p.status='completed'
          AND p.payment_purpose IN ('invoice_collection','invoice_collection_with_credit','subscriber_credit')
      )
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='deposit'),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='transfer_in'),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='withdrawal' AND t.related_expense_id IS NOT NULL),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='withdrawal' AND t.related_supplier_payment_id IS NOT NULL),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_type='transfer_out'),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='withdrawal'
        AND t.related_expense_id IS NULL
        AND t.related_supplier_payment_id IS NULL
        AND t.related_payment_id IS NULL
        AND t.related_supplier_return_id IS NULL
    ),0)::numeric(14,2)
  INTO
    v_cash_transaction_inflows,
    v_cash_transaction_outflows,
    v_collection_cash,
    v_other_collection_cash,
    v_deposit_cash,
    v_transfer_in_cash,
    v_expense_cash_out,
    v_supplier_payment_cash_out,
    v_transfer_out_cash,
    v_other_withdrawal_cash
  FROM public.account_transactions t
  WHERE t.tenant_id = p_tenant_id
    AND t.site_id = p_site_id
    AND t.occurred_at >= p_period_start
    AND t.occurred_at <= p_period_end;

  SELECT
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='deposit'
        AND t.related_payment_id IS NOT NULL
        AND p.payment_purpose='security_deposit'
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='deposit' AND t.related_supplier_return_id IS NOT NULL
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='withdrawal'
        AND t.related_payment_id IS NOT NULL
        AND p.payment_purpose='security_deposit_refund'
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='deposit'
        AND NOT (t.related_payment_id IS NOT NULL AND p.payment_purpose='security_deposit')
        AND t.related_supplier_return_id IS NULL
    ),0)::numeric(14,2),
    COALESCE(SUM(t.amount) FILTER (
      WHERE t.transaction_type='withdrawal'
        AND t.related_payment_id IS NOT NULL
        AND COALESCE(p.payment_purpose,'') <> 'security_deposit_refund'
    ),0)::numeric(14,2)
  INTO
    v_security_deposit_cash_in,
    v_supplier_return_cash_in,
    v_security_deposit_refund_cash_out,
    v_other_deposit_cash,
    v_other_payment_cash_out
  FROM public.account_transactions t
  LEFT JOIN public.payments p
    ON p.tenant_id = t.tenant_id
   AND p.site_id = t.site_id
   AND p.id = t.related_payment_id
  WHERE t.tenant_id = p_tenant_id
    AND t.site_id = p_site_id
    AND t.occurred_at >= p_period_start
    AND t.occurred_at <= p_period_end;

  SELECT count(*)::bigint
  INTO v_orphan_reference_movement_count
  FROM public.account_transactions t
  WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id
    AND t.occurred_at >= p_period_start AND t.occurred_at <= p_period_end
    AND (
      num_nonnulls(t.related_payment_id,t.related_expense_id,t.related_supplier_payment_id,t.related_supplier_return_id) > 1
      OR (t.related_payment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.tenant_id=t.tenant_id AND p.site_id=t.site_id AND p.id=t.related_payment_id
          AND p.status='completed' AND p.paid_at >= p_period_start AND p.paid_at <= p_period_end
      ))
      OR (t.related_expense_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.expenses e
        WHERE e.tenant_id=t.tenant_id AND e.site_id=t.site_id AND e.id=t.related_expense_id
          AND e.occurred_at >= p_period_start AND e.occurred_at <= p_period_end
      ))
      OR (t.related_supplier_payment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.supplier_payments sp
        WHERE sp.tenant_id=t.tenant_id AND sp.site_id=t.site_id
          AND sp.id=t.related_supplier_payment_id AND sp.status='posted'
          AND sp.payment_date >= (p_period_start AT TIME ZONE 'UTC')::date
          AND sp.payment_date <= (p_period_end AT TIME ZONE 'UTC')::date
      ))
      OR (t.related_supplier_return_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.supplier_purchase_returns r
        WHERE r.tenant_id=t.tenant_id AND r.site_id=t.site_id
          AND r.id=t.related_supplier_return_id AND r.status='posted' AND r.refund_amount>0
          AND r.return_date >= (p_period_start AT TIME ZONE 'UTC')::date
          AND r.return_date <= (p_period_end AT TIME ZONE 'UTC')::date
      ))
    );

  SELECT count(*)::bigint
  INTO v_unlinked_account_movement_count
  FROM public.account_transactions t
  WHERE t.tenant_id = p_tenant_id
    AND t.site_id = p_site_id
    AND t.occurred_at <= p_period_end
    AND NOT EXISTS (
      SELECT 1
      FROM public.company_account_sites cas
      WHERE cas.tenant_id = t.tenant_id
        AND cas.account_id = t.account_id
        AND cas.site_id = t.site_id
    );

  v_cash_inflows := round(v_cash_transaction_inflows + v_account_opening_balance_added,2);
  v_cash_outflows := v_cash_transaction_outflows;

  v_cash_balance_complete :=
    v_unallocated_shared_opening_balance = 0
    AND v_unlinked_account_movement_count = 0
    AND v_orphan_reference_movement_count = 0
    AND v_payment_cash_mismatch_count = 0
    AND v_expense_cash_mismatch_count = 0
    AND v_supplier_payment_cash_mismatch_count = 0
    AND v_supplier_return_cash_mismatch_count = 0;

  v_integrity_issue_count :=
    v_payment_cash_mismatch_count
    + v_expense_cash_mismatch_count
    + v_supplier_payment_cash_mismatch_count
    + v_supplier_return_cash_mismatch_count
    + v_unlinked_account_movement_count
    + v_orphan_reference_movement_count
    + v_unclassified_inventory_movement_count
    + CASE WHEN v_unallocated_shared_opening_balance <> 0 THEN 1 ELSE 0 END;

  v_is_reconciled := v_cash_balance_complete AND v_unclassified_inventory_movement_count=0;

  IF v_cash_balance_complete THEN
    v_book_cash_balance := round(v_cash_opening_balance + v_cash_inflows - v_cash_outflows,2);
  ELSE
    v_book_cash_balance := NULL;
  END IF;

  RETURN jsonb_build_object(
    'tenantId',p_tenant_id,
    'siteId',p_site_id,
    'periodStart',p_period_start,
    'periodEnd',p_period_end,
    'totalCollected',v_total_collected,
    'totalExpenses',v_total_expenses,
    'inventoryConsumptionCost',v_inventory_consumption_cost,
    'inventoryCapitalAssetIssueCost',v_inventory_capital_asset_issue_cost,
    'unclassifiedInventoryMovementCount',v_unclassified_inventory_movement_count,
    'inventoryExpensesByCategory',v_inventory_expenses_by_category,
    'bookProfit',v_book_profit,
    'cashOpeningBalance',v_cash_opening_balance,
    'cashInflows',v_cash_inflows,
    'cashOutflows',v_cash_outflows,
    'bookCashBalance',v_book_cash_balance,
    'cashBalanceComplete',v_cash_balance_complete,
    'isReconciled',v_is_reconciled,
    'subscriberCreditCreated',v_subscriber_credit_created,
    'securityDepositReceived',v_security_deposit_received,
    'securityDepositRefunded',v_security_deposit_refunded,
    'supplierPaymentAmount',v_supplier_payment_amount,
    'supplierPurchaseInvoiceAmount',v_supplier_purchase_invoice_amount,
    'supplierReturnCreditAmount',v_supplier_return_credit_amount,
    'supplierReturnRefundAmount',v_supplier_return_refund_amount,
    'operatingExpensesByCategory',v_operating_expenses_by_category,
    'cashBreakdown',jsonb_build_object(
      'inflows',jsonb_build_object(
        'subscriberCollections',v_collection_cash,
        'otherCollections',v_other_collection_cash,
        'securityDepositReceipts',v_security_deposit_cash_in,
        'supplierReturnRefunds',v_supplier_return_cash_in,
        'otherDeposits',v_other_deposit_cash,
        'transfersIn',v_transfer_in_cash,
        'accountOpeningBalanceAdded',v_account_opening_balance_added
      ),
      'outflows',jsonb_build_object(
        'operatingExpenses',v_expense_cash_out,
        'supplierPayments',v_supplier_payment_cash_out,
        'securityDepositRefunds',v_security_deposit_refund_cash_out,
        'otherPaymentRefunds',v_other_payment_cash_out,
        'otherWithdrawals',v_other_withdrawal_cash,
        'transfersOut',v_transfer_out_cash
      )
    ),
    'reconciliation',jsonb_build_object(
      'paymentCashMismatchCount',v_payment_cash_mismatch_count,
      'expenseCashMismatchCount',v_expense_cash_mismatch_count,
      'supplierPaymentCashMismatchCount',v_supplier_payment_cash_mismatch_count,
      'supplierReturnCashMismatchCount',v_supplier_return_cash_mismatch_count,
      'unlinkedAccountMovementCount',v_unlinked_account_movement_count,
      'orphanReferenceMovementCount',v_orphan_reference_movement_count,
      'unclassifiedInventoryMovementCount',v_unclassified_inventory_movement_count,
      'inventoryCapitalAssetIssueCost',v_inventory_capital_asset_issue_cost,
      'unallocatedSharedOpeningBalance',v_unallocated_shared_opening_balance,
      'issueCount',v_integrity_issue_count,
      'status',CASE WHEN v_is_reconciled THEN 'reconciled' ELSE 'attention_required' END
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_financial_settlement_source_fingerprint(p_tenant_id bigint, p_site_id bigint, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT md5(jsonb_build_object(
    'payments',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'amount',p.amount,'invoiceAppliedAmount',p.invoice_applied_amount,
        'subscriberCreditAmount',p.subscriber_credit_amount,'paymentPurpose',p.payment_purpose,
        'status',p.status,'paidAt',p.paid_at
      ) ORDER BY p.id)
      FROM public.payments p
      WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id AND p.status='completed'
        AND p.paid_at>=p_period_start AND p.paid_at<=p_period_end
    ),'[]'::jsonb),
    'expenses',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',e.id,'amount',e.amount,'category',e.category,'occurredAt',e.occurred_at
      ) ORDER BY e.id)
      FROM public.expenses e
      WHERE e.tenant_id=p_tenant_id AND e.site_id=p_site_id
        AND e.occurred_at>=p_period_start AND e.occurred_at<=p_period_end
    ),'[]'::jsonb),
    'accountTransactions',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',t.id,'accountId',t.account_id,'siteId',t.site_id,
        'transactionType',t.transaction_type,'amount',t.amount,'occurredAt',t.occurred_at,'relatedPaymentId',t.related_payment_id,
        'relatedExpenseId',t.related_expense_id,'relatedSupplierPaymentId',t.related_supplier_payment_id,
        'relatedSupplierReturnId',t.related_supplier_return_id
      ) ORDER BY t.id)
      FROM public.account_transactions t
      WHERE t.tenant_id=p_tenant_id AND t.site_id=p_site_id AND t.occurred_at<=p_period_end
    ),'[]'::jsonb),
    'supplierPayments',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',sp.id,'amount',sp.amount,'paymentDate',sp.payment_date,
        'status',sp.status,'accountTransactionId',sp.account_transaction_id
      ) ORDER BY sp.id)
      FROM public.supplier_payments sp
      WHERE sp.tenant_id=p_tenant_id AND sp.site_id=p_site_id AND sp.status='posted'
        AND sp.payment_date>=(p_period_start AT TIME ZONE 'UTC')::date
        AND sp.payment_date<=(p_period_end AT TIME ZONE 'UTC')::date
    ),'[]'::jsonb),
    'supplierReturns',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',r.id,'totalCreditAmount',r.total_credit_amount,'refundAmount',r.refund_amount,
        'returnDate',r.return_date,'status',r.status
      ) ORDER BY r.id)
      FROM public.supplier_purchase_returns r
      WHERE r.tenant_id=p_tenant_id AND r.site_id=p_site_id AND r.status='posted'
        AND r.return_date>=(p_period_start AT TIME ZONE 'UTC')::date
        AND r.return_date<=(p_period_end AT TIME ZONE 'UTC')::date
    ),'[]'::jsonb),
    'supplierPurchases',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'totalAmount',p.total_amount,'invoiceDate',p.invoice_date,'status',p.status
      ) ORDER BY p.id)
      FROM public.supplier_purchases p
      WHERE p.tenant_id=p_tenant_id AND p.site_id=p_site_id
        AND p.invoice_date>=(p_period_start AT TIME ZONE 'UTC')::date
        AND p.invoice_date<=(p_period_end AT TIME ZONE 'UTC')::date
        AND p.status IN ('confirmed','partially_received','received')
    ),'[]'::jsonb),
    'inventoryMovements',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',m.id,'warehouseId',m.warehouse_id,'itemId',m.item_id,'generatorId',m.generator_id,
        'accountingTreatment',i.accounting_treatment,
        'movementType',m.movement_type,'quantity',m.quantity,'unitCost',m.unit_cost,
        'totalCostAmount',m.total_cost_amount,'occurredAt',m.occurred_at,
        'sourceIssueMovementId',m.source_issue_movement_id,
        'reversalOfMovementId',m.reversal_of_movement_id,'correctsMovementId',m.corrects_movement_id
      ) ORDER BY m.id)
      FROM public.inventory_stock_movements m
      JOIN public.inventory_items i ON i.tenant_id=m.tenant_id AND i.id=m.item_id
      WHERE m.tenant_id=p_tenant_id AND m.site_id=p_site_id
        AND m.occurred_at>=p_period_start AND m.occurred_at<=p_period_end
    ),'[]'::jsonb),
    'companyAccounts',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',ca.id,'openingBalance',ca.opening_balance,'createdAt',ca.created_at,
        'siteIds',(SELECT COALESCE(jsonb_agg(cas.site_id ORDER BY cas.site_id),'[]'::jsonb)
          FROM public.company_account_sites cas
          WHERE cas.tenant_id=ca.tenant_id AND cas.account_id=ca.id)
      ) ORDER BY ca.id)
      FROM public.company_accounts ca
      WHERE ca.tenant_id=p_tenant_id AND EXISTS (
        SELECT 1 FROM public.company_account_sites cas
        WHERE cas.tenant_id=ca.tenant_id AND cas.account_id=ca.id AND cas.site_id=p_site_id
      )
    ),'[]'::jsonb)
  )::text)
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_guard_financial_settlement_source_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
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

    WHEN 'inventory_stock_movements' THEN
      IF TG_OP='UPDATE' THEN
        IF ROW(OLD.id,OLD.tenant_id,OLD.site_id,OLD.movement_type,OLD.quantity,OLD.unit_cost,
                 OLD.total_cost_amount,OLD.occurred_at,OLD.reversal_of_movement_id,
                 OLD.corrects_movement_id,OLD.source_issue_movement_id)
             IS NOT DISTINCT FROM
             ROW(NEW.id,NEW.tenant_id,NEW.site_id,NEW.movement_type,NEW.quantity,NEW.unit_cost,
                 NEW.total_cost_amount,NEW.occurred_at,NEW.reversal_of_movement_id,
                 NEW.corrects_movement_id,NEW.source_issue_movement_id) THEN
          RETURN NEW;
        END IF;
      END IF;
      IF TG_OP<>'INSERT' THEN
        v_scopes:=v_scopes||jsonb_build_array(jsonb_build_object(
          'tenant_id',OLD.tenant_id,'site_id',OLD.site_id,
          'guard_mode','timestamp','event_at',OLD.occurred_at
        ));
      END IF;
      IF TG_OP<>'DELETE' THEN
        v_scopes:=v_scopes||jsonb_build_array(jsonb_build_object(
          'tenant_id',NEW.tenant_id,'site_id',NEW.site_id,
          'guard_mode','timestamp','event_at',NEW.occurred_at
        ));
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

DROP TRIGGER IF EXISTS zz_powerhub_financial_settlement_source_write_guard ON public.inventory_stock_movements;
CREATE TRIGGER zz_powerhub_financial_settlement_source_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.powerhub_guard_financial_settlement_source_write();

COMMENT ON FUNCTION public.powerhub_financial_settlement_preview(bigint,bigint,timestamptz,timestamptz)
  IS 'Settlement preview includes cash expenses plus net non-cash inventory issues (fuel, oils, filters, parts and supplies), without adding supplier payments or inventory transfers as P&L expense.';

NOTIFY pgrst, 'reload schema';

NOTIFY pgrst,'reload schema';
