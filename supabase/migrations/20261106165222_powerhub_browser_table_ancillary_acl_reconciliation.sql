-- Remove browser-only ancillary table privileges from the public schema.
-- Keep all current SELECT grants and service_role permissions unchanged.
-- Direct Support Center mutations must go through the reviewed RPC boundary.

DO $preflight$
DECLARE
  v_table text;
  v_oid oid;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'chat_support_categories',
    'chat_support_feedback',
    'chat_support_quick_replies',
    'chat_support_sla_policies',
    'chat_support_tags'
  ] LOOP
    v_oid := to_regclass('public.' || v_table);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'CHAT_SUPPORT_ACL_TABLE_MISSING: %', v_table;
    END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'CHAT_SUPPORT_ACL_RLS_DISABLED: %', v_table;
    END IF;

    IF NOT has_table_privilege('authenticated', v_oid, 'SELECT')
       OR NOT EXISTS (
         SELECT 1
         FROM pg_policy p
         WHERE p.polrelid = v_oid
           AND p.polcmd IN ('r', '*')
           AND (SELECT oid FROM pg_roles WHERE rolname = 'authenticated') = ANY(p.polroles)
       ) THEN
      RAISE EXCEPTION 'CHAT_SUPPORT_AUTHENTICATED_READ_CONTRACT_MISSING: %', v_table;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_policy p
      WHERE p.polrelid = v_oid
        AND p.polcmd IN ('*', 'a', 'w', 'd')
        AND (
          0 = ANY(p.polroles)
          OR (SELECT oid FROM pg_roles WHERE rolname = 'anon') = ANY(p.polroles)
          OR (SELECT oid FROM pg_roles WHERE rolname = 'authenticated') = ANY(p.polroles)
        )
    ) THEN
      RAISE EXCEPTION 'CHAT_SUPPORT_DIRECT_WRITE_POLICY_REQUIRES_REVIEW: %', v_table;
    END IF;

    IF NOT has_table_privilege('service_role', v_oid, 'SELECT')
       OR NOT has_table_privilege('service_role', v_oid, 'INSERT')
       OR NOT has_table_privilege('service_role', v_oid, 'UPDATE')
       OR NOT has_table_privilege('service_role', v_oid, 'DELETE')
       OR NOT has_table_privilege('service_role', v_oid, 'TRUNCATE')
       OR NOT has_table_privilege('service_role', v_oid, 'REFERENCES')
       OR NOT has_table_privilege('service_role', v_oid, 'TRIGGER')
       OR NOT has_table_privilege('service_role', v_oid, 'MAINTAIN') THEN
      RAISE EXCEPTION 'CHAT_SUPPORT_SERVICE_ROLE_PRIVILEGE_MISSING: %', v_table;
    END IF;
  END LOOP;
END
$preflight$;

-- These are schema/maintenance capabilities, not application-level access.
-- Remove them for browser roles on all public tables. Existing SELECT and
-- ordinary DML grants are not changed by this section.
DO $revoke_ancillary$
DECLARE
  v_table record;
BEGIN
  FOR v_table IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format(
      'REVOKE REFERENCES, TRIGGER, MAINTAIN ON TABLE %I.%I FROM PUBLIC, anon, authenticated',
      v_table.schema_name,
      v_table.table_name
    );
  END LOOP;
END
$revoke_ancillary$;

-- Support Center browser reads remain available under RLS, but writes and
-- TRUNCATE are server-mediated through authenticated RPCs.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  public.chat_support_categories,
  public.chat_support_feedback,
  public.chat_support_quick_replies,
  public.chat_support_sla_policies,
  public.chat_support_tags
FROM PUBLIC, anon, authenticated;

DO $postflight$
DECLARE
  v_table record;
  v_name text;
  v_oid oid;
BEGIN
  FOR v_table IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, c.oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    IF has_table_privilege('anon', v_table.oid, 'REFERENCES')
       OR has_table_privilege('anon', v_table.oid, 'TRIGGER')
       OR has_table_privilege('anon', v_table.oid, 'MAINTAIN')
       OR has_table_privilege('authenticated', v_table.oid, 'REFERENCES')
       OR has_table_privilege('authenticated', v_table.oid, 'TRIGGER')
       OR has_table_privilege('authenticated', v_table.oid, 'MAINTAIN')
       OR EXISTS (
         SELECT 1
         FROM aclexplode(coalesce(
           (SELECT c.relacl FROM pg_class c WHERE c.oid = v_table.oid),
           acldefault('r', (SELECT c.relowner FROM pg_class c WHERE c.oid = v_table.oid))
         )) a
         WHERE a.grantee = 0
           AND a.privilege_type IN ('REFERENCES', 'TRIGGER', 'MAINTAIN')
       ) THEN
      RAISE EXCEPTION 'BROWSER_ANCILLARY_TABLE_PRIVILEGE_REMAINS: %.%',
        v_table.schema_name, v_table.table_name;
    END IF;
  END LOOP;

  FOREACH v_name IN ARRAY ARRAY[
    'chat_support_categories',
    'chat_support_feedback',
    'chat_support_quick_replies',
    'chat_support_sla_policies',
    'chat_support_tags'
  ] LOOP
    v_oid := to_regclass('public.' || v_name);

    IF NOT has_table_privilege('authenticated', v_oid, 'SELECT')
       OR has_table_privilege('authenticated', v_oid, 'INSERT')
       OR has_table_privilege('authenticated', v_oid, 'UPDATE')
       OR has_table_privilege('authenticated', v_oid, 'DELETE')
       OR has_table_privilege('authenticated', v_oid, 'TRUNCATE')
       OR has_table_privilege('anon', v_oid, 'INSERT')
       OR has_table_privilege('anon', v_oid, 'UPDATE')
       OR has_table_privilege('anon', v_oid, 'DELETE')
       OR has_table_privilege('anon', v_oid, 'TRUNCATE') THEN
      RAISE EXCEPTION 'CHAT_SUPPORT_BROWSER_ACL_MISMATCH: %', v_name;
    END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid)
       OR NOT EXISTS (
         SELECT 1 FROM pg_policy p
         WHERE p.polrelid = v_oid
           AND p.polcmd IN ('r', '*')
           AND (SELECT oid FROM pg_roles WHERE rolname = 'authenticated') = ANY(p.polroles)
       ) THEN
      RAISE EXCEPTION 'CHAT_SUPPORT_RLS_READ_CONTRACT_CHANGED: %', v_name;
    END IF;

    IF NOT has_table_privilege('service_role', v_oid, 'SELECT')
       OR NOT has_table_privilege('service_role', v_oid, 'INSERT')
       OR NOT has_table_privilege('service_role', v_oid, 'UPDATE')
       OR NOT has_table_privilege('service_role', v_oid, 'DELETE')
       OR NOT has_table_privilege('service_role', v_oid, 'TRUNCATE')
       OR NOT has_table_privilege('service_role', v_oid, 'REFERENCES')
       OR NOT has_table_privilege('service_role', v_oid, 'TRIGGER')
       OR NOT has_table_privilege('service_role', v_oid, 'MAINTAIN') THEN
      RAISE EXCEPTION 'CHAT_SUPPORT_SERVICE_ROLE_ACL_CHANGED: %', v_name;
    END IF;
  END LOOP;
END
$postflight$;
