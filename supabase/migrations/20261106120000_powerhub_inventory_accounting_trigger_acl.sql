-- Restrict the two inventory accounting trigger functions to server-side use.
-- Their existing triggers continue to run; only direct EXECUTE grants are tightened.
DO $inventory_accounting_trigger_preflight$
BEGIN
  IF to_regprocedure('public.powerhub_inventory_set_default_accounting_treatment()') IS NULL
     OR to_regprocedure('public.powerhub_guard_inventory_item_accounting_treatment_write()') IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_ACCOUNTING_TRIGGER_FUNCTION_MISSING';
  END IF;

  IF (SELECT prorettype FROM pg_proc WHERE oid='public.powerhub_inventory_set_default_accounting_treatment()'::regprocedure)
        <> 'trigger'::regtype
     OR (SELECT prorettype FROM pg_proc WHERE oid='public.powerhub_guard_inventory_item_accounting_treatment_write()'::regprocedure)
        <> 'trigger'::regtype THEN
    RAISE EXCEPTION 'INVENTORY_ACCOUNTING_TRIGGER_RETURN_TYPE_CHANGED';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.powerhub_inventory_set_default_accounting_treatment()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid='public.powerhub_guard_inventory_item_accounting_treatment_write()'::regprocedure) THEN
    RAISE EXCEPTION 'INVENTORY_ACCOUNTING_TRIGGER_SECURITY_MODE_CHANGED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.inventory_items'::regclass
      AND tgname='powerhub_inventory_item_accounting_defaults'
      AND tgfoid='public.powerhub_inventory_set_default_accounting_treatment()'::regprocedure
      AND tgenabled<>'D' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.inventory_items'::regclass
      AND tgname='powerhub_inventory_item_accounting_lock_guard'
      AND tgfoid='public.powerhub_guard_inventory_item_accounting_treatment_write()'::regprocedure
      AND tgenabled<>'D' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'INVENTORY_ACCOUNTING_TRIGGER_ATTACHMENT_MISSING';
  END IF;
END
$inventory_accounting_trigger_preflight$;

REVOKE ALL PRIVILEGES ON FUNCTION public.powerhub_inventory_set_default_accounting_treatment()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_inventory_set_default_accounting_treatment()
  TO service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.powerhub_guard_inventory_item_accounting_treatment_write()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_guard_inventory_item_accounting_treatment_write()
  TO service_role;

DO $inventory_accounting_trigger_postflight$
BEGIN
  IF has_function_privilege('anon','public.powerhub_inventory_set_default_accounting_treatment()','EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_inventory_set_default_accounting_treatment()','EXECUTE')
     OR has_function_privilege('anon','public.powerhub_guard_inventory_item_accounting_treatment_write()','EXECUTE')
     OR has_function_privilege('authenticated','public.powerhub_guard_inventory_item_accounting_treatment_write()','EXECUTE') THEN
    RAISE EXCEPTION 'INVENTORY_ACCOUNTING_TRIGGER_BROWSER_EXECUTE_REMAINS';
  END IF;

  IF NOT has_function_privilege('service_role','public.powerhub_inventory_set_default_accounting_treatment()','EXECUTE')
     OR NOT has_function_privilege('service_role','public.powerhub_guard_inventory_item_accounting_treatment_write()','EXECUTE') THEN
    RAISE EXCEPTION 'INVENTORY_ACCOUNTING_TRIGGER_SERVICE_EXECUTE_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.inventory_items'::regclass
      AND tgname='powerhub_inventory_item_accounting_defaults'
      AND tgfoid='public.powerhub_inventory_set_default_accounting_treatment()'::regprocedure
      AND tgenabled<>'D' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.inventory_items'::regclass
      AND tgname='powerhub_inventory_item_accounting_lock_guard'
      AND tgfoid='public.powerhub_guard_inventory_item_accounting_treatment_write()'::regprocedure
      AND tgenabled<>'D' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'INVENTORY_ACCOUNTING_TRIGGER_DISABLED_BY_ACL_MIGRATION';
  END IF;
END
$inventory_accounting_trigger_postflight$;
