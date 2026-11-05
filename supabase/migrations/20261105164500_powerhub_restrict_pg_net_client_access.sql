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
END
$migration$;
