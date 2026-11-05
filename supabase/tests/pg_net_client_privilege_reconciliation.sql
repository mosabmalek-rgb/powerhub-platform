\set ON_ERROR_STOP on

DO $roles$
BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END
$roles$;
DO $roles$
BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END
$roles$;
DO $roles$
BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END
$roles$;
DO $roles$
BEGIN CREATE ROLE supabase_admin NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END
$roles$;

CREATE SCHEMA IF NOT EXISTS net;
GRANT CREATE ON SCHEMA net TO supabase_admin;
GRANT USAGE ON SCHEMA net TO PUBLIC;

SET ROLE supabase_admin;
CREATE OR REPLACE FUNCTION net.powerhub_security_probe()
RETURNS integer
LANGUAGE sql
AS $$ SELECT 42 $$;
RESET ROLE;

GRANT EXECUTE ON FUNCTION net.powerhub_security_probe() TO PUBLIC;

DO $before$
BEGIN
  IF NOT has_schema_privilege('anon','net','USAGE')
     OR NOT has_schema_privilege('authenticated','net','USAGE')
     OR NOT has_function_privilege('anon','net.powerhub_security_probe()','EXECUTE')
     OR NOT has_function_privilege('authenticated','net.powerhub_security_probe()','EXECUTE') THEN
    RAISE EXCEPTION 'PG_NET_FIXTURE_DID_NOT_START_WITH_PUBLIC_EXECUTION';
  END IF;
END
$before$;

\ir ../migrations/20261105164500_powerhub_restrict_pg_net_client_access.sql

DO $existing$
BEGIN
  IF has_schema_privilege('anon','net','USAGE')
     OR has_schema_privilege('authenticated','net','USAGE')
     OR NOT has_schema_privilege('service_role','net','USAGE') THEN
    RAISE EXCEPTION 'PG_NET_SCHEMA_ACCESS_NOT_RESTRICTED_TO_SERVER_ROLE';
  END IF;

  IF has_function_privilege('anon','net.powerhub_security_probe()','EXECUTE')
     OR has_function_privilege('authenticated','net.powerhub_security_probe()','EXECUTE')
     OR NOT has_function_privilege('service_role','net.powerhub_security_probe()','EXECUTE') THEN
    RAISE EXCEPTION 'PG_NET_EXISTING_FUNCTION_ACL_NOT_RECONCILED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE n.nspname='net'
      AND p.proname='powerhub_security_probe'
      AND acl.grantee=0
      AND acl.privilege_type='EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PG_NET_PUBLIC_EXECUTE_GRANT_REMAINS';
  END IF;
END
$existing$;

SET ROLE supabase_admin;
CREATE OR REPLACE FUNCTION net.powerhub_future_security_probe()
RETURNS integer
LANGUAGE sql
AS $$ SELECT 7 $$;
RESET ROLE;

DO $future$
BEGIN
  IF has_function_privilege('anon','net.powerhub_future_security_probe()','EXECUTE')
     OR has_function_privilege('authenticated','net.powerhub_future_security_probe()','EXECUTE')
     OR NOT has_function_privilege('service_role','net.powerhub_future_security_probe()','EXECUTE') THEN
    RAISE EXCEPTION 'PG_NET_FUTURE_FUNCTION_DEFAULT_ACL_NOT_RESTRICTED';
  END IF;
END
$future$;

SELECT 'PG_NET_CLIENT_PRIVILEGES_RESTRICTED' AS result;
