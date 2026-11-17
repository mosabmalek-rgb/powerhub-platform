-- Local-only Supabase Vault compatibility preflight for Production-derived Docker Shadow.
-- Source pg_catalog evidence: Production vault schema owned by supabase_admin,
-- supabase_vault 0.3.1 installed in vault, with vault.secrets and decrypted_secrets.
-- Run ONLY with local Supabase-admin through docker exec against --network none.
DO $pr359_vault_schema$
DECLARE schema_owner text;
BEGIN
 SELECT pg_get_userbyid(nspowner) INTO schema_owner
 FROM pg_namespace WHERE nspname='vault';
 IF schema_owner IS NULL THEN
   EXECUTE 'CREATE SCHEMA vault AUTHORIZATION supabase_admin';
 ELSIF schema_owner <> 'supabase_admin' THEN
   RAISE EXCEPTION 'PR359_DOCKER_VAULT_SCHEMA_OWNER_DRIFT';
 END IF;
END
$pr359_vault_schema$;

-- Do not silently accept a different Vault extension version or namespace.
DO $pr359_vault_available$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_available_extension_versions
   WHERE name='supabase_vault' AND version='0.3.1'
 ) AND NOT EXISTS (
   SELECT 1 FROM pg_extension WHERE extname='supabase_vault' AND extversion='0.3.1'
 ) THEN
   RAISE EXCEPTION 'PR359_DOCKER_SUPABASE_VAULT_0_3_1_UNAVAILABLE';
 END IF;
END
$pr359_vault_available$;

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault VERSION '0.3.1';

DO $pr359_vault_verify$
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
   WHERE e.extname='supabase_vault' AND e.extversion='0.3.1' AND n.nspname='vault'
 ) THEN
   RAISE EXCEPTION 'PR359_DOCKER_VAULT_EXTENSION_MISMATCH';
 END IF;
 IF to_regclass('vault.secrets') IS NULL OR to_regclass('vault.decrypted_secrets') IS NULL THEN
   RAISE EXCEPTION 'PR359_DOCKER_VAULT_OBJECTS_MISSING';
 END IF;
END
$pr359_vault_verify$;
