-- pg_net is a server-side HTTP transport, not a browser API.
-- The extension is intentionally left installed in its current schema; this
-- migration only restricts callers and the queue/response objects it owns.
REVOKE ALL ON SCHEMA net FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA net TO service_role, postgres;

-- pg_net functions execute with the caller's privileges in the deployed
-- extension version. Keep the complete API and its internal helpers available
-- to trusted server code, but not to browser roles through inherited PUBLIC ACLs.
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA net
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA net TO service_role, postgres;

-- The HTTP request queue and retained responses are internal transport state.
-- Service-role server code may collect results; browser roles get no direct DML.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA net
  FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA net TO service_role, postgres;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA net
  FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA net TO service_role, postgres;

