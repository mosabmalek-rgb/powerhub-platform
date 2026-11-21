-- Fail closed for future application objects created by postgres in public.
-- Existing object ACLs are deliberately untouched.
--
-- Supabase-managed supabase_admin defaults are not modified here. Its public
-- defaults remain a separately monitored provider-managed boundary.
--
-- PUBLIC EXECUTE is a global PostgreSQL function default. Revoke it
-- globally and remove any schema-specific PUBLIC EXECUTE defaults as well.
-- No future postgres-owned function receives PUBLIC EXECUTE in any schema.

DO $preflight$
BEGIN
  IF pg_catalog.to_regnamespace('public') IS NULL
     OR pg_catalog.to_regnamespace('extensions') IS NULL
     OR pg_catalog.to_regnamespace('storage') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_DEFAULT_PRIVILEGE_REQUIRED_SCHEMA_OR_ROLE_MISSING';
  END IF;

  -- The global function revoke affects every schema for functions created by
  -- postgres. Refuse to proceed if the live project has postgres-owned
  -- routines in a schema outside the reviewed application/provider set.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid=routine.pronamespace
    WHERE routine.proowner='postgres'::regrole
      AND namespace.nspname NOT IN (
        'public',
        'private',
        'powerhub_private',
        'extensions',
        'storage',
        'pg_catalog',
        'information_schema'
      )
  ) THEN
    RAISE EXCEPTION 'POWERHUB_DEFAULT_PRIVILEGE_UNREVIEWED_POSTGRES_ROUTINE_SCHEMA';
  END IF;

  -- Likewise, schema-specific postgres function defaults outside the reviewed
  -- set require a dedicated decision before the global PUBLIC change.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS defaults
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid=defaults.defaclnamespace
    WHERE defaults.defaclrole='postgres'::regrole
      AND defaults.defaclobjtype='f'
      AND namespace.nspname NOT IN (
        'public','extensions','storage','pg_catalog','information_schema'
      )
  ) THEN
    RAISE EXCEPTION 'POWERHUB_DEFAULT_PRIVILEGE_UNREVIEWED_FUNCTION_DEFAULT_SCHEMA';
  END IF;
END
$preflight$;

-- Future public tables and sequences are server-only by default. A feature
-- that needs browser reads must add an explicit GRANT together with RLS and
-- its tenant/site-scoped policy in that feature's migration.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated;

-- Functions need both layers: remove any public-schema grants to browser
-- roles, and remove PostgreSQL's built-in global PUBLIC EXECUTE default.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Schema-specific default ACLs are additive to global defaults. Remove
-- explicit PUBLIC EXECUTE grants with static, reviewed statements. Existing
-- function ACLs remain untouched.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extensions
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA pg_catalog
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA information_schema
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
    WHERE defaults.defaclrole='postgres'::regrole
      AND defaults.defaclnamespace='public'::regnamespace
      AND defaults.defaclobjtype IN ('r','S','f')
      AND acl.grantee IN ('anon'::regrole,'authenticated'::regrole)
  ) THEN
    RAISE EXCEPTION 'POWERHUB_PUBLIC_BROWSER_DEFAULT_PRIVILEGE_REMAINS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl AS defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
    WHERE defaults.defaclrole='postgres'::regrole
      AND defaults.defaclnamespace='public'::regnamespace
      AND defaults.defaclobjtype='r'
      AND acl.grantee='service_role'::regrole
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl AS defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
    WHERE defaults.defaclrole='postgres'::regrole
      AND defaults.defaclnamespace='public'::regnamespace
      AND defaults.defaclobjtype='S'
      AND acl.grantee='service_role'::regrole
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl AS defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
    WHERE defaults.defaclrole='postgres'::regrole
      AND defaults.defaclnamespace='public'::regnamespace
      AND defaults.defaclobjtype='f'
      AND acl.grantee='service_role'::regrole
      AND acl.privilege_type='EXECUTE'
  ) THEN
    RAISE EXCEPTION 'POWERHUB_SERVICE_ROLE_DEFAULT_GRANTS_CHANGED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
    WHERE defaults.defaclrole='postgres'::regrole
      AND defaults.defaclnamespace=0
      AND defaults.defaclobjtype='f'
      AND acl.grantee=0
      AND acl.privilege_type='EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
    WHERE defaults.defaclrole='postgres'::regrole
      AND defaults.defaclnamespace='public'::regnamespace
      AND defaults.defaclobjtype='f'
      AND acl.grantee=0
      AND acl.privilege_type='EXECUTE'
  ) THEN
    RAISE EXCEPTION 'POWERHUB_PUBLIC_FUNCTION_EXECUTE_DEFAULT_REMAINS';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS acl
    WHERE defaults.defaclrole='postgres'::regrole
      AND defaults.defaclobjtype='f'
      AND acl.grantee=0
      AND acl.privilege_type='EXECUTE'
  ) THEN
    RAISE EXCEPTION 'POWERHUB_POSTGRES_PUBLIC_FUNCTION_DEFAULT_REMAINS';
  END IF;
END
$postflight$;
