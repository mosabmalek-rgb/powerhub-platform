-- PR359 Docker-only parity bootstrap, 2026-11-17.
-- Read-only catalog audit verified that hosted test Production does not have
-- pg_graphql installed and graphql.seq_schema_version is absent.
-- The Supabase Postgres 17 image can preload an extension and event trigger
-- absent on the source, causing stale OID references in schema restore.
-- This runs ONLY in a networkless disposable Docker container via local superuser.
-- Fail closed if the image cannot be made equivalent without CASCADE.
DO $pr359_graphql_parity$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_graphql') THEN
   DROP EXTENSION pg_graphql RESTRICT;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_graphql')
    OR to_regclass('graphql.seq_schema_version') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'graphql' AND p.proname = 'increment_schema_version'
    )
 THEN RAISE EXCEPTION 'PR359_SHADOW_GRAPHQL_PARITY_FAILED';
 END IF;
END
$pr359_graphql_parity$;
