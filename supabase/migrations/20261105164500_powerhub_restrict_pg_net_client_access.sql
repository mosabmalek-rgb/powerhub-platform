-- pg_net can issue outbound HTTP requests. Do not leave its request
-- functions callable by anonymous or authenticated API users via PUBLIC grants.
-- Server-side application operations retain access through service_role, and
-- the extension owner/postgres retain their owner/superuser privileges.
DO $migration$
BEGIN
  IF to_regnamespace('net') IS NULL THEN
    RETURN;
  END IF;

  REVOKE USAGE ON SCHEMA net FROM PUBLIC, anon, authenticated;
  GRANT USAGE ON SCHEMA net TO service_role;

  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA net TO service_role;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA net REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA net GRANT EXECUTE ON FUNCTIONS TO service_role';
  END IF;
END
$migration$;
