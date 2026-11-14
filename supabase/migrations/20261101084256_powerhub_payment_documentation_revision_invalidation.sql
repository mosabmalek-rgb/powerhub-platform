-- Revision-only invalidation for Payment Documentation review queues.
-- No request row, receipt reference, amount, subscriber identity, or payment data is
-- added to powerhub_sync_changes or included in Realtime payloads.

DO $preflight$
BEGIN
  IF to_regclass('public.powerhub_sync_scope_state') IS NULL
     OR to_regclass('public.payment_documentation_requests') IS NULL
     OR to_regclass('public.sites') IS NULL
     OR to_regprocedure('private.powerhub_broadcast_delta_scope_revision()') IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_REVISION_DEPENDENCY_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.powerhub_sync_scope_state'::regclass
      AND tgname='powerhub_sync_scope_state_broadcast_delta'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_REVISION_BROADCAST_TRIGGER_MISSING';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity FROM pg_class c
    WHERE c.oid='public.powerhub_sync_scope_state'::regclass
  ) THEN
    RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_REVISION_SCOPE_RLS_REQUIRED';
  END IF;

  IF has_table_privilege('anon','public.powerhub_sync_scope_state','SELECT')
     OR has_table_privilege('authenticated','public.powerhub_sync_scope_state','SELECT')
     OR has_table_privilege('anon','public.powerhub_sync_scope_state','INSERT')
     OR has_table_privilege('authenticated','public.powerhub_sync_scope_state','INSERT')
     OR has_table_privilege('anon','public.powerhub_sync_scope_state','UPDATE')
     OR has_table_privilege('authenticated','public.powerhub_sync_scope_state','UPDATE')
     OR has_table_privilege('anon','public.powerhub_sync_scope_state','DELETE')
     OR has_table_privilege('authenticated','public.powerhub_sync_scope_state','DELETE') THEN
    RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_REVISION_SCOPE_MUST_REMAIN_SERVER_ONLY';
  END IF;
END
$preflight$;

-- This cursor is intentionally revision-only. It is not a pullable Delta entity;
-- it merely drives the already-protected central Realtime invalidation trigger.
ALTER TABLE public.powerhub_sync_scope_state
  DROP CONSTRAINT IF EXISTS powerhub_sync_scope_state_entity_type_check;

ALTER TABLE public.powerhub_sync_scope_state
  ADD CONSTRAINT powerhub_sync_scope_state_entity_type_check
  CHECK (
    entity_type IN (
      'sites','subscribers','generators','readings','tariffs','invoices','payments','expenses',
      'company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers',
      'inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers',
      'inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings',
      'maintenance_preventive_plans','fuel_events','maintenance_work_orders',
      'hr_employee_directory','hr_attendance','hr_employee_advances','hr_payroll_runs',
      'supplier_ledger','payment_documentation'
    )
    OR entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$'
  );

CREATE OR REPLACE FUNCTION private.powerhub_capture_payment_documentation_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
VOLATILE
AS $function$
BEGIN
  -- A scope move invalidates both old and new sites. Other operations advance one cursor.
  IF TG_OP = 'DELETE'
     OR (
       TG_OP = 'UPDATE'
       AND (
         OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR OLD.site_id IS DISTINCT FROM NEW.site_id
       )
     ) THEN
    -- The old site may already have been deleted by an ON DELETE CASCADE.
    -- Positive identifiers are sufficient for advancing its historical cursor.
    IF OLD.tenant_id IS NULL OR OLD.tenant_id < 1
       OR OLD.site_id IS NULL OR OLD.site_id < 1 THEN
      RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_REVISION_SCOPE_INVALID' USING ERRCODE='23503';
    END IF;

    INSERT INTO public.powerhub_sync_scope_state(
      tenant_id,site_id,entity_type,last_cursor,retained_from_cursor,updated_at
    )
    VALUES(OLD.tenant_id,OLD.site_id,'payment_documentation',1,0,pg_catalog.clock_timestamp())
    ON CONFLICT(tenant_id,site_id,entity_type) DO UPDATE
      SET last_cursor=public.powerhub_sync_scope_state.last_cursor+1,
          updated_at=pg_catalog.clock_timestamp();
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF NEW.tenant_id IS NULL OR NEW.tenant_id < 1
       OR NEW.site_id IS NULL OR NEW.site_id < 1
       OR NOT EXISTS (
         SELECT 1 FROM public.sites s
         WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.site_id
       ) THEN
      RAISE EXCEPTION 'PAYMENT_DOCUMENTATION_REVISION_SCOPE_INVALID' USING ERRCODE='23503';
    END IF;

    INSERT INTO public.powerhub_sync_scope_state(
      tenant_id,site_id,entity_type,last_cursor,retained_from_cursor,updated_at
    )
    VALUES(NEW.tenant_id,NEW.site_id,'payment_documentation',1,0,pg_catalog.clock_timestamp())
    ON CONFLICT(tenant_id,site_id,entity_type) DO UPDATE
      SET last_cursor=public.powerhub_sync_scope_state.last_cursor+1,
          updated_at=pg_catalog.clock_timestamp();
  END IF;

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION private.powerhub_capture_payment_documentation_revision() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.powerhub_capture_payment_documentation_revision()
  FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS powerhub_payment_documentation_revision
  ON public.payment_documentation_requests;

CREATE TRIGGER powerhub_payment_documentation_revision
AFTER INSERT OR UPDATE OR DELETE
ON public.payment_documentation_requests
FOR EACH ROW
EXECUTE FUNCTION private.powerhub_capture_payment_documentation_revision();
