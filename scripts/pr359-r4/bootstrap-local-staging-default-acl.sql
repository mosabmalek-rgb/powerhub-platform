-- R4 local disposable restore ONLY. Source-attested postgres default ACL
-- contract for future application objects. No hosted Staging/Production DDL.
-- Run after Supabase managed stack initialization and role bootstrap, before
-- restoring application schema. Refuse to continue until the catalog SHA-256
-- equals the independent read-only hosted Staging MVCC source attestation.
BEGIN;
-- Global EXECUTE PUBLIC is the upstream default for functions unless revoked.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
 REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
-- Strip unreviewed global browser/service table and sequence grants. Schema
-- grants are then recreated explicitly in source-approved least-privilege form.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
 REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
 REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 GRANT EXECUTE ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 GRANT ALL ON SEQUENCES TO service_role;
COMMIT;
