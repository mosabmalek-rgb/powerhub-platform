-- Restrict direct authenticated reads to the caller's assigned branch.
-- Existing permissive tenant policies remain in place for their established write
-- paths; these restrictive SELECT policies are additive and do not replace them.
DO $preflight$
DECLARE
  target record;
BEGIN
  IF to_regprocedure('private.powerhub_has_site_access(bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'SITE_BOUND_READ_SCOPE_HELPER_MISSING';
  END IF;

  FOR target IN
    SELECT * FROM (VALUES
      ('sites', 'tenant_id', 'id'),
      ('subscribers', 'tenant_id', 'site_id'),
      ('tariffs', 'tenant_id', 'site_id'),
      ('complaints', 'tenant_id', 'site_id'),
      ('collector_sessions', 'tenant_id', 'site_id'),
      ('mobile_sync_events', 'tenant_id', 'site_id'),
      ('offline_sync_operations', 'tenant_id', 'site_id'),
      ('access_invitations', 'tenant_id', 'site_id'),
      ('staff_profiles', 'tenant_id', 'site_id'),
      ('site_portal_settings', 'tenant_id', 'site_id'),
      ('meters', 'tenant_id', 'subscriber_id')
    ) AS scoped(table_name, tenant_column, scope_column)
  LOOP
    IF to_regclass(format('public.%I', target.table_name)) IS NULL THEN
      RAISE EXCEPTION 'SITE_BOUND_READ_SCOPE_TABLE_MISSING: %', target.table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_attribute a
      WHERE a.attrelid = to_regclass(format('public.%I', target.table_name))
        AND a.attname = target.tenant_column
        AND a.attnum > 0
        AND NOT a.attisdropped
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_attribute a
      WHERE a.attrelid = to_regclass(format('public.%I', target.table_name))
        AND a.attname = target.scope_column
        AND a.attnum > 0
        AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'SITE_BOUND_READ_SCOPE_COLUMN_MISSING: %.%', target.table_name, target.scope_column;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid = to_regclass(format('public.%I', target.table_name))
        AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'SITE_BOUND_READ_SCOPE_RLS_DISABLED: %', target.table_name;
    END IF;
  END LOOP;
END
$preflight$;

-- Direct site relationship: a user sees only the site(s) assigned to them.
DO $install_site_guards$
DECLARE
  target record;
  predicate text;
  policy_name text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('sites', 'private.powerhub_has_site_access(tenant_id, id)'),
      ('subscribers', 'private.powerhub_has_site_access(tenant_id, site_id)'),
      ('tariffs', 'private.powerhub_has_site_access(tenant_id, site_id)'),
      ('complaints', 'private.powerhub_has_site_access(tenant_id, site_id)'),
      ('collector_sessions', 'private.powerhub_has_site_access(tenant_id, site_id)'),
      ('mobile_sync_events', 'private.powerhub_has_site_access(tenant_id, site_id)'),
      ('offline_sync_operations', 'private.powerhub_has_site_access(tenant_id, site_id)'),
      ('access_invitations', 'private.powerhub_has_site_access(tenant_id, site_id)'),
      ('staff_profiles', 'private.powerhub_has_site_access(tenant_id, site_id)'),
      ('site_portal_settings', 'private.powerhub_has_site_access(tenant_id, site_id)')
    ) AS scoped(table_name, predicate)
  LOOP
    policy_name := target.table_name || '_site_scope_read_guard';
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, target.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (%s)',
      policy_name,
      target.table_name,
      target.predicate
    );
  END LOOP;

  -- meters has no site_id. Resolve its scope through its owning subscriber so a
  -- meter cannot escape branch isolation through a parent relationship.
  DROP POLICY IF EXISTS meters_subscriber_site_scope_read_guard ON public.meters;
  CREATE POLICY meters_subscriber_site_scope_read_guard
    ON public.meters
    AS RESTRICTIVE
    FOR SELECT
    TO authenticated
    USING (
      EXISTS (
        SELECT 1
        FROM public.subscribers parent
        WHERE parent.tenant_id = meters.tenant_id
          AND parent.id = meters.subscriber_id
          AND private.powerhub_has_site_access(parent.tenant_id, parent.site_id)
      )
    );
END
$install_site_guards$;

-- These records are server-owned. Application access is mediated by server-side
-- tRPC/REST handlers using supabaseAdmin() and audited RPCs. There are no direct
-- browser table reads or authenticated SECURITY INVOKER routines that depend on
-- these grants. Keep the branch guards above as defense in depth if a reviewed
-- future route intentionally introduces a direct read.
REVOKE SELECT ON TABLE
  public.mobile_api_sessions,
  public.collector_sessions,
  public.mobile_sync_events,
  public.offline_sync_operations,
  public.access_invitations,
  public.staff_profiles,
  public.site_portal_settings
FROM PUBLIC, anon, authenticated;

DO $assertions$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'sites','subscribers','tariffs','complaints','collector_sessions',
    'mobile_sync_events','offline_sync_operations','access_invitations',
    'staff_profiles','site_portal_settings','meters'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = target
        AND roles = ARRAY['authenticated']::name[]
        AND cmd = 'SELECT'
        AND permissive = 'RESTRICTIVE'
        AND policyname = CASE
          WHEN target = 'meters' THEN 'meters_subscriber_site_scope_read_guard'
          ELSE target || '_site_scope_read_guard'
        END
        AND coalesce(qual, '') <> ''
    ) THEN
      RAISE EXCEPTION 'SITE_BOUND_READ_GUARD_MISSING: %', target;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'mobile_api_sessions','collector_sessions','mobile_sync_events',
      'offline_sync_operations','access_invitations','staff_profiles','site_portal_settings'
    ]) AS server_only(table_name)
    WHERE has_table_privilege('anon', format('public.%I', server_only.table_name), 'SELECT')
       OR has_table_privilege('authenticated', format('public.%I', server_only.table_name), 'SELECT')
  ) THEN
    RAISE EXCEPTION 'SERVER_OWNED_TABLE_BROWSER_SELECT_GRANT_REMAINS';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'mobile_api_sessions','collector_sessions','mobile_sync_events',
      'offline_sync_operations','access_invitations','staff_profiles','site_portal_settings'
    ]) AS server_only(table_name)
    WHERE NOT has_table_privilege('service_role', format('public.%I', server_only.table_name), 'SELECT')
  ) THEN
    RAISE EXCEPTION 'SERVER_OWNED_TABLE_SERVER_SELECT_GRANT_MISSING';
  END IF;
END
$assertions$;

NOTIFY pgrst, 'reload schema';
