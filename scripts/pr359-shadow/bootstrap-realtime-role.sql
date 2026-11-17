-- PR359: strictly local Docker-only compatibility for a single hosted Supabase reserved role.
-- Source pg_roles verified on 2026-11-17 (project vvcdiqcyhaloxesvpppc):
-- supabase_realtime_admin: NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
--                          NOREPLICATION NOBYPASSRLS.
-- Never apply to Staging/Production or call through a remote database connection.
DO $pr359_local_role$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_realtime_admin') THEN
   CREATE ROLE supabase_realtime_admin
     NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
     NOREPLICATION NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM pg_roles
   WHERE rolname='supabase_realtime_admin'
     AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
     AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
     AND NOT rolbypassrls
 ) THEN
   RAISE EXCEPTION 'PR359_SHADOW_RESERVED_ROLE_MISMATCH';
 END IF;
END
$pr359_local_role$;
