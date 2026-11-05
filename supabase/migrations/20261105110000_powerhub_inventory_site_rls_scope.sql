-- Restrict branch-bound inventory and generator reads to the user's assigned site.
-- Inventory catalog items and suppliers remain tenant-wide; operational rows do not.
-- This migration narrows SELECT visibility and removes stale anon SELECT grants.
-- Existing authenticated write policies and service_role DML grants are preserved.
-- Writes remain behind existing server RPCs.

DO $preflight$
DECLARE target text;
BEGIN
  IF to_regprocedure('private.powerhub_has_site_access(bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_SITE_ACCESS_HELPER_MISSING';
  END IF;

  FOREACH target IN ARRAY ARRAY[
    'generators',
    'inventory_warehouses',
    'inventory_stock_movements'
  ] LOOP
    IF to_regclass(format('public.%I',target)) IS NULL THEN
      RAISE EXCEPTION 'INVENTORY_SITE_RLS_TABLE_MISSING: %',target;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=target AND column_name='site_id'
    ) THEN
      RAISE EXCEPTION 'INVENTORY_SITE_RLS_SITE_COLUMN_MISSING: %',target;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid=to_regclass(format('public.%I',target)) AND relrowsecurity
    ) THEN
      RAISE EXCEPTION 'INVENTORY_SITE_RLS_DISABLED: %',target;
    END IF;
  END LOOP;
END
$preflight$;

-- These operational tables are not anonymous read surfaces. Remove any stale
-- explicit anon SELECT grant before asserting the intended access boundary.
REVOKE SELECT ON TABLE
  public.generators,
  public.inventory_warehouses,
  public.inventory_stock_movements
FROM anon;

-- Existing tenant/site indexes already support these predicates; avoid redundant indexes.

-- Add a restrictive SELECT guard. Existing permissive policies remain intact,
-- including generators' ALL policy that is required for existing write paths.
DO $replace_policies$
DECLARE
  target text;
  policy_name text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'generators',
    'inventory_warehouses',
    'inventory_stock_movements'
  ] LOOP
    policy_name := target || '_site_scope_read';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polrelid=to_regclass(format('public.%I',target))
        AND polname=policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (private.powerhub_has_site_access(tenant_id,site_id))',
        policy_name,
        target
      );
    END IF;
  END LOOP;
END
$replace_policies$;

DO $assertions$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'generators',
    'inventory_warehouses',
    'inventory_stock_movements'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public'
        AND tablename=target
        AND policyname=target || '_site_scope_read'
        AND roles='{authenticated}'
        AND cmd='SELECT'
        AND permissive='RESTRICTIVE'
        AND coalesce(qual,'') ILIKE '%powerhub_has_site_access%'
    ) THEN
      RAISE EXCEPTION 'INVENTORY_SITE_RLS_POLICY_ASSERTION_FAILED: %',target;
    END IF;
    IF NOT has_table_privilege('authenticated',format('public.%I',target),'SELECT') THEN
      RAISE EXCEPTION 'INVENTORY_SITE_RLS_SELECT_GRANT_MISSING: %',target;
    END IF;
    IF has_table_privilege('anon',format('public.%I',target),'SELECT') THEN
      RAISE EXCEPTION 'INVENTORY_SITE_RLS_ANON_GRANT_PRESENT: %',target;
    END IF;
    IF NOT has_table_privilege('service_role',format('public.%I',target),'SELECT') THEN
      RAISE EXCEPTION 'INVENTORY_SITE_RLS_SERVICE_ROLE_GRANT_MISSING: %',target;
    END IF;
  END LOOP;

  -- Preserve the existing generator write policy; the new guard is SELECT-only.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='generators'
      AND policyname='generators_tenant_isolation'
      AND roles='{authenticated}'
      AND cmd='ALL'
      AND permissive='PERMISSIVE'
      AND coalesce(qual,'') <> ''
      AND coalesce(with_check,'') <> ''
  ) THEN
    RAISE EXCEPTION 'INVENTORY_SITE_RLS_GENERATOR_WRITE_POLICY_NOT_PRESERVED';
  END IF;
END
$assertions$;

NOTIFY pgrst,'reload schema';
