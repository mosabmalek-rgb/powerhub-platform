\set ON_ERROR_STOP on

-- This is a disposable PostgreSQL regression fixture. It models the broad
-- defaults observed in Staging; it is NOT a migration and must never be applied
-- to a hosted Supabase project. The simulated supabase_admin defaults below
-- demonstrate inheritance only. Hosted Supabase does not let postgres alter
-- the managed supabase_admin defaults.
DO $roles$
BEGIN
  BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE supabase_admin NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

ALTER ROLE service_role BYPASSRLS;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE, CREATE ON SCHEMA public TO supabase_admin;
GRANT USAGE, CREATE ON SCHEMA extensions, storage TO postgres;

-- Reproduce the live Staging defaults for postgres-owned public objects.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Reproduce the separate postgres-owned storage defaults. The migration must
-- preserve their effective behavior while changing public application defaults.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage
  GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage
  GRANT ALL PRIVILEGES ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Negative control: a schema-scoped REVOKE cannot remove PostgreSQL's global
-- PUBLIC EXECUTE baseline. The forward migration must revoke it globally.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Model objects created under the Supabase-managed extension owner. This is
-- intentionally a test-only simulation; application migrations must not try
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin. Its built-in PUBLIC
-- function default is left intact, just as on the hosted Staging project.
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Validate the actual PostgreSQL catalog rows created by ALTER DEFAULT PRIVILEGES.
-- This is intentionally a positive-control fixture: the check must detect every
-- client-role/object-type/owner combination, not infer defaults only from one
-- subsequently-created object.
DO $default_acl_catalog_detection$
DECLARE
  v_expected record;
BEGIN
  FOR v_expected IN
    SELECT *
    FROM (VALUES
      ('postgres', 'r', 'anon'),
      ('postgres', 'r', 'authenticated'),
      ('postgres', 'S', 'anon'),
      ('postgres', 'S', 'authenticated'),
      ('postgres', 'f', 'anon'),
      ('postgres', 'f', 'authenticated'),
      ('supabase_admin', 'r', 'anon'),
      ('supabase_admin', 'r', 'authenticated'),
      ('supabase_admin', 'S', 'anon'),
      ('supabase_admin', 'S', 'authenticated'),
      ('supabase_admin', 'f', 'anon'),
      ('supabase_admin', 'f', 'authenticated')
    ) AS expected(owner_name, object_type, grantee_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_default_acl AS defaults
      CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
      WHERE defaults.defaclrole = v_expected.owner_name::regrole
        AND defaults.defaclnamespace = 'public'::regnamespace
        AND defaults.defaclobjtype::text = v_expected.object_type
        AND acl.grantee = v_expected.grantee_name::regrole
        AND acl.privilege_type IS NOT NULL
    ) THEN
      RAISE EXCEPTION
        'DEFAULT_ACL_CATALOG_ENTRY_NOT_DETECTED: owner=% object_type=% grantee=%',
        v_expected.owner_name, v_expected.object_type, v_expected.grantee_name;
    END IF;
  END LOOP;

  -- A schema-level REVOKE does not cancel PostgreSQL's global function
  -- default. This positive control proves the original exposure exists.
  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.aclexplode(
         pg_catalog.acldefault('f','postgres'::regrole)
       ) AS acl
       WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.aclexplode(
         pg_catalog.acldefault('f','supabase_admin'::regrole)
       ) AS acl
       WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'BUILTIN_PUBLIC_FUNCTION_DEFAULT_BASELINE_NOT_REPRODUCED';
  END IF;
END
$default_acl_catalog_detection$;

CREATE TABLE public.default_privileges_postgres_fixture (
  id bigint PRIMARY KEY,
  tenant_id bigint NOT NULL,
  payload text NOT NULL
);
CREATE SEQUENCE public.default_privileges_postgres_sequence;
CREATE FUNCTION public.default_privileges_postgres_function()
RETURNS text
LANGUAGE sql
AS $function$
  SELECT 'postgres-owned';
$function$;

INSERT INTO public.default_privileges_postgres_fixture(id, tenant_id, payload)
VALUES (1, 10, 'tenant ten'), (2, 20, 'tenant twenty');

-- Prove that the unsafe inherited defaults really affected each new object.
DO $inherited_postgres_acl$
BEGIN
  IF NOT has_table_privilege('anon', 'public.default_privileges_postgres_fixture', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.default_privileges_postgres_fixture', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.default_privileges_postgres_fixture', 'DELETE') THEN
    RAISE EXCEPTION 'POSTGRES_TABLE_DEFAULT_ACL_FIXTURE_NOT_REPRODUCED';
  END IF;

  IF NOT has_sequence_privilege('anon', 'public.default_privileges_postgres_sequence', 'USAGE')
     OR NOT has_sequence_privilege('authenticated', 'public.default_privileges_postgres_sequence', 'UPDATE')
     OR NOT has_sequence_privilege('service_role', 'public.default_privileges_postgres_sequence', 'SELECT') THEN
    RAISE EXCEPTION 'POSTGRES_SEQUENCE_DEFAULT_ACL_FIXTURE_NOT_REPRODUCED';
  END IF;

  IF NOT has_function_privilege('anon', 'public.default_privileges_postgres_function()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.default_privileges_postgres_function()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.default_privileges_postgres_function()', 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid = 'public.default_privileges_postgres_function()'::regprocedure
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'POSTGRES_FUNCTION_DEFAULT_ACL_FIXTURE_NOT_REPRODUCED';
  END IF;
END
$inherited_postgres_acl$;

-- Supabase-managed owner simulation: new public objects inherit its broad
-- defaults. A live guard must detect these objects, not attempt to edit the
-- managed role's default ACL.
SET ROLE supabase_admin;
CREATE TABLE public.default_privileges_managed_owner_fixture (id bigint PRIMARY KEY);
CREATE SEQUENCE public.default_privileges_managed_owner_sequence;
CREATE FUNCTION public.default_privileges_managed_owner_function()
RETURNS text
LANGUAGE sql
AS $function$
  SELECT 'managed-owner';
$function$;
RESET ROLE;

DO $managed_owner_detection$
DECLARE
  v_table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)::name
    INTO v_table_owner
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'default_privileges_managed_owner_fixture'
    AND c.relkind IN ('r', 'p');

  IF v_table_owner <> 'supabase_admin'
     OR NOT has_table_privilege('anon', 'public.default_privileges_managed_owner_fixture', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.default_privileges_managed_owner_fixture', 'DELETE')
     OR NOT has_sequence_privilege('anon', 'public.default_privileges_managed_owner_sequence', 'USAGE')
     OR NOT has_function_privilege('authenticated', 'public.default_privileges_managed_owner_function()', 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f',p.proowner))
       ) AS acl
       WHERE p.oid='public.default_privileges_managed_owner_function()'::regprocedure
         AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'SUPABASE_ADMIN_DEFAULT_ACL_INHERITANCE_NOT_DETECTED';
  END IF;
END
$managed_owner_detection$;

-- Apply the exact forward migration. Existing objects created above must keep
-- their current ACLs; only objects created after this point use the new defaults.
\ir ../migrations/20261107150951_powerhub_public_default_privilege_hardening.sql

-- Snapshot all postgres default ACLs after the first application, then replay
-- the same migration to prove it is idempotent and introduces no ACL drift.
CREATE TEMP TABLE powerhub_default_acl_repeat_snapshot AS
SELECT defaclrole, defaclnamespace, defaclobjtype, defaclacl::text AS acl
FROM pg_catalog.pg_default_acl
WHERE defaclrole='postgres'::regrole;

\ir ../migrations/20261107150951_powerhub_public_default_privilege_hardening.sql

DO $migration_replay_idempotency$
BEGIN
  IF EXISTS (
    SELECT defaclrole, defaclnamespace, defaclobjtype, acl
    FROM pg_temp.powerhub_default_acl_repeat_snapshot
    EXCEPT
    SELECT defaclrole, defaclnamespace, defaclobjtype, defaclacl::text
    FROM pg_catalog.pg_default_acl
    WHERE defaclrole='postgres'::regrole
  ) OR EXISTS (
    SELECT defaclrole, defaclnamespace, defaclobjtype, defaclacl::text
    FROM pg_catalog.pg_default_acl
    WHERE defaclrole='postgres'::regrole
    EXCEPT
    SELECT defaclrole, defaclnamespace, defaclobjtype, acl
    FROM pg_temp.powerhub_default_acl_repeat_snapshot
  ) THEN
    RAISE EXCEPTION 'POWERHUB_DEFAULT_PRIVILEGE_MIGRATION_REPLAY_CHANGED_ACL';
  END IF;
END
$migration_replay_idempotency$;

DROP TABLE pg_temp.powerhub_default_acl_repeat_snapshot;

DO $existing_object_acl_preserved$
BEGIN
  IF NOT has_table_privilege('anon','public.default_privileges_postgres_fixture','SELECT')
     OR NOT has_table_privilege('authenticated','public.default_privileges_postgres_fixture','SELECT')
     OR NOT has_sequence_privilege('anon','public.default_privileges_postgres_sequence','USAGE')
     OR NOT has_function_privilege('anon','public.default_privileges_postgres_function()','EXECUTE')
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))
       ) acl
       WHERE p.oid='public.default_privileges_postgres_function()'::regprocedure
         AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'DEFAULT_PRIVILEGE_MIGRATION_CHANGED_EXISTING_OBJECT_ACL';
  END IF;
END
$existing_object_acl_preserved$;

-- New public objects are closed to browser roles by default. A future feature
-- must explicitly grant only the necessary access and pair it with RLS.
CREATE TABLE public.default_privileges_future_fixture (
  id bigint PRIMARY KEY,
  tenant_id bigint NOT NULL,
  payload text NOT NULL
);
CREATE SEQUENCE public.default_privileges_future_sequence;
CREATE FUNCTION public.default_privileges_future_function()
RETURNS text
LANGUAGE sql
AS $function$
  SELECT 'future-public';
$function$;
INSERT INTO public.default_privileges_future_fixture(id,tenant_id,payload)
VALUES (1,10,'tenant ten'),(2,20,'tenant twenty');

GRANT SELECT ON TABLE public.default_privileges_future_fixture TO authenticated;
ALTER TABLE public.default_privileges_future_fixture ENABLE ROW LEVEL SECURITY;
CREATE POLICY default_privileges_future_tenant_read
ON public.default_privileges_future_fixture
FOR SELECT TO authenticated
USING (
  tenant_id = NULLIF(current_setting('powerhub.test_tenant_id',true),'')::bigint
);

-- Future functions created by postgres in provider/system schemas
-- must also remain closed to PUBLIC after the global default revoke.
CREATE FUNCTION extensions.default_privileges_future_extension_function()
RETURNS text LANGUAGE sql AS $function$ SELECT 'extension'; $function$;
CREATE FUNCTION storage.default_privileges_future_storage_function()
RETURNS text LANGUAGE sql AS $function$ SELECT 'storage'; $function$;

-- Verify the provider-managed supabase_admin defaults were not changed.
SET ROLE supabase_admin;
CREATE TABLE public.default_privileges_managed_owner_future_fixture (id bigint PRIMARY KEY);
CREATE FUNCTION public.default_privileges_managed_owner_future_function()
RETURNS text LANGUAGE sql AS $function$ SELECT 'managed-owner-future'; $function$;
RESET ROLE;

DO $future_acl_contract$
BEGIN
  IF has_table_privilege('anon','public.default_privileges_future_fixture','SELECT')
     OR has_table_privilege('authenticated','public.default_privileges_future_fixture','INSERT')
     OR has_table_privilege('authenticated','public.default_privileges_future_fixture','UPDATE')
     OR has_table_privilege('authenticated','public.default_privileges_future_fixture','DELETE')
     OR has_sequence_privilege('anon','public.default_privileges_future_sequence','USAGE')
     OR has_sequence_privilege('authenticated','public.default_privileges_future_sequence','USAGE')
     OR has_function_privilege('anon','public.default_privileges_future_function()','EXECUTE')
     OR has_function_privilege('authenticated','public.default_privileges_future_function()','EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))
       ) acl
       WHERE p.oid='public.default_privileges_future_function()'::regprocedure
         AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'FUTURE_PUBLIC_BROWSER_DEFAULT_PRIVILEGE_REMAINS';
  END IF;

  IF NOT has_table_privilege('authenticated','public.default_privileges_future_fixture','SELECT')
     OR NOT has_table_privilege('service_role','public.default_privileges_future_fixture','SELECT')
     OR NOT has_table_privilege('service_role','public.default_privileges_future_fixture','INSERT')
     OR NOT has_table_privilege('service_role','public.default_privileges_future_fixture','UPDATE')
     OR NOT has_table_privilege('service_role','public.default_privileges_future_fixture','DELETE')
     OR NOT has_sequence_privilege('service_role','public.default_privileges_future_sequence','USAGE')
     OR NOT has_sequence_privilege('service_role','public.default_privileges_future_sequence','SELECT')
     OR NOT has_sequence_privilege('service_role','public.default_privileges_future_sequence','UPDATE')
     OR NOT has_function_privilege('service_role','public.default_privileges_future_function()','EXECUTE') THEN
    RAISE EXCEPTION 'FUTURE_PUBLIC_SERVICE_ROLE_DEFAULT_GRANTS_MISSING';
  END IF;

  IF has_function_privilege('anon','extensions.default_privileges_future_extension_function()','EXECUTE')
     OR has_function_privilege('authenticated','extensions.default_privileges_future_extension_function()','EXECUTE')
     OR NOT has_function_privilege('anon','storage.default_privileges_future_storage_function()','EXECUTE')
     OR NOT has_function_privilege('authenticated','storage.default_privileges_future_storage_function()','EXECUTE')
     OR NOT has_function_privilege('service_role','storage.default_privileges_future_storage_function()','EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))
       ) acl
       WHERE p.oid='extensions.default_privileges_future_extension_function()'::regprocedure
         AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))
       ) acl
       WHERE p.oid='storage.default_privileges_future_storage_function()'::regprocedure
         AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'PROVIDER_SCHEMA_PUBLIC_FUNCTION_DEFAULT_REMAINS';
  END IF;

  IF NOT has_table_privilege('anon','public.default_privileges_managed_owner_future_fixture','SELECT')
     OR NOT has_table_privilege('authenticated','public.default_privileges_managed_owner_future_fixture','SELECT')
     OR NOT has_function_privilege('anon','public.default_privileges_managed_owner_future_function()','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.default_privileges_managed_owner_future_function()','EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))
       ) acl
       WHERE p.oid='public.default_privileges_managed_owner_future_function()'::regprocedure
         AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'SUPABASE_ADMIN_MANAGED_DEFAULTS_WERE_CHANGED';
  END IF;
END
$future_acl_contract$;

SET ROLE authenticated;
SELECT set_config('powerhub.test_tenant_id','10',false);
DO $future_tenant_isolation$
DECLARE
  v_rows bigint;
BEGIN
  SELECT count(*) INTO v_rows FROM public.default_privileges_future_fixture;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'FUTURE_DEFAULT_ACL_RLS_SCOPE_FAILED: expected=1 actual=%',v_rows;
  END IF;
END
$future_tenant_isolation$;
RESET ROLE;

-- The application-owned objects are repaired at object scope. Authenticated
-- retains only the intended RLS-protected read; server-side service_role keeps
-- the operational permissions. Sequences and this RPC are server-only.
REVOKE ALL ON TABLE public.default_privileges_postgres_fixture
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.default_privileges_postgres_fixture TO authenticated;
GRANT ALL PRIVILEGES ON TABLE public.default_privileges_postgres_fixture TO service_role;

REVOKE ALL ON SEQUENCE public.default_privileges_postgres_sequence
  FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON SEQUENCE public.default_privileges_postgres_sequence TO service_role;

REVOKE ALL ON FUNCTION public.default_privileges_postgres_function()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.default_privileges_postgres_function() TO service_role;

ALTER TABLE public.default_privileges_postgres_fixture ENABLE ROW LEVEL SECURITY;
CREATE POLICY default_privileges_fixture_tenant_read
ON public.default_privileges_postgres_fixture
FOR SELECT TO authenticated
USING (
  tenant_id = NULLIF(current_setting('powerhub.test_tenant_id', true), '')::bigint
);

DO $object_acl_contract$
BEGIN
  IF has_table_privilege('anon', 'public.default_privileges_postgres_fixture', 'SELECT')
     OR has_table_privilege('anon', 'public.default_privileges_postgres_fixture', 'INSERT')
     OR has_table_privilege('authenticated', 'public.default_privileges_postgres_fixture', 'INSERT')
     OR has_table_privilege('authenticated', 'public.default_privileges_postgres_fixture', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.default_privileges_postgres_fixture', 'DELETE') THEN
    RAISE EXCEPTION 'POSTGRES_TABLE_CLIENT_ACL_NOT_RESTRICTED';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.default_privileges_postgres_fixture', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.default_privileges_postgres_fixture', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.default_privileges_postgres_fixture', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.default_privileges_postgres_fixture', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.default_privileges_postgres_fixture', 'DELETE') THEN
    RAISE EXCEPTION 'POSTGRES_TABLE_REQUIRED_GRANTS_MISSING';
  END IF;

  IF has_sequence_privilege('anon', 'public.default_privileges_postgres_sequence', 'USAGE')
     OR has_sequence_privilege('authenticated', 'public.default_privileges_postgres_sequence', 'USAGE')
     OR has_sequence_privilege('authenticated', 'public.default_privileges_postgres_sequence', 'SELECT')
     OR has_sequence_privilege('authenticated', 'public.default_privileges_postgres_sequence', 'UPDATE')
     OR NOT has_sequence_privilege('service_role', 'public.default_privileges_postgres_sequence', 'USAGE')
     OR NOT has_sequence_privilege('service_role', 'public.default_privileges_postgres_sequence', 'SELECT')
     OR NOT has_sequence_privilege('service_role', 'public.default_privileges_postgres_sequence', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTGRES_SEQUENCE_CLIENT_ACL_NOT_RESTRICTED';
  END IF;

  IF has_function_privilege('anon', 'public.default_privileges_postgres_function()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.default_privileges_postgres_function()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.default_privileges_postgres_function()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTGRES_FUNCTION_CLIENT_ACL_NOT_RESTRICTED';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.default_privileges_postgres_fixture'::regclass
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'default_privileges_postgres_fixture'
      AND policyname = 'default_privileges_fixture_tenant_read'
      AND cmd = 'SELECT'
      AND roles = ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'POSTGRES_TABLE_RLS_POLICY_MISSING';
  END IF;
END
$object_acl_contract$;

SET ROLE authenticated;
SELECT set_config('powerhub.test_tenant_id', '10', false);
DO $tenant_isolation$
DECLARE
  v_rows bigint;
BEGIN
  SELECT count(*) INTO v_rows FROM public.default_privileges_postgres_fixture;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'DEFAULT_ACL_FIXTURE_RLS_SCOPE_FAILED: expected=1 actual=%', v_rows;
  END IF;
END
$tenant_isolation$;
RESET ROLE;

SET ROLE anon;
DO $anonymous_denial$
BEGIN
  IF has_table_privilege(current_user, 'public.default_privileges_postgres_fixture', 'SELECT')
     OR has_sequence_privilege(current_user, 'public.default_privileges_postgres_sequence', 'USAGE')
     OR has_function_privilege(current_user, 'public.default_privileges_postgres_function()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ANON_RETAINED_DEFAULT_ACL_ACCESS';
  END IF;
END
$anonymous_denial$;
RESET ROLE;

SET ROLE service_role;
DO $service_access$
DECLARE
  v_rows bigint;
  v_result text;
BEGIN
  SELECT count(*) INTO v_rows FROM public.default_privileges_postgres_fixture;
  SELECT public.default_privileges_postgres_function() INTO v_result;
  IF v_rows <> 2 OR v_result <> 'postgres-owned' THEN
    RAISE EXCEPTION 'SERVICE_ROLE_ACCESS_REGRESSED: rows=% result=%', v_rows, v_result;
  END IF;
END
$service_access$;
RESET ROLE;

SELECT 'DEFAULT_PRIVILEGES_ACL_GUARD_PASSED' AS result;
