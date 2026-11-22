-- Disposable PostgreSQL only; this script MUST NOT be run on a hosted DB.
-- Create real app-class objects under source-pinned default ACL and confirm
-- effective browser/service role access. ROLLBACK removes all probe objects.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
DO $guard$
BEGIN
 IF current_user <> 'postgres' THEN
  RAISE EXCEPTION 'PR359_LOCAL_ACL_PROBE_REQUIRES_POSTGRES_ROLE';
 END IF;
END;
$guard$;
CREATE FUNCTION public.pr359_local_acl_create_probe() RETURNS integer
 LANGUAGE sql AS 'SELECT 359';
CREATE TABLE public.pr359_local_acl_create_table (
 id bigint PRIMARY KEY
);
CREATE SEQUENCE public.pr359_local_acl_create_sequence;
DO $checks$
BEGIN
 IF has_function_privilege('anon','public.pr359_local_acl_create_probe()','EXECUTE')
    OR has_function_privilege('authenticated','public.pr359_local_acl_create_probe()','EXECUTE')
    OR NOT has_function_privilege('service_role','public.pr359_local_acl_create_probe()','EXECUTE') THEN
   RAISE EXCEPTION 'PR359_LOCAL_FUNCTION_CREATION_ACL_DRIFT';
 END IF;
 IF has_table_privilege('anon','public.pr359_local_acl_create_table','SELECT')
    OR has_table_privilege('authenticated','public.pr359_local_acl_create_table','SELECT')
    OR NOT has_table_privilege('service_role','public.pr359_local_acl_create_table','SELECT') THEN
   RAISE EXCEPTION 'PR359_LOCAL_TABLE_CREATION_ACL_DRIFT';
 END IF;
 IF has_sequence_privilege('anon','public.pr359_local_acl_create_sequence','USAGE')
    OR has_sequence_privilege('authenticated','public.pr359_local_acl_create_sequence','USAGE')
    OR NOT has_sequence_privilege('service_role','public.pr359_local_acl_create_sequence','USAGE') THEN
   RAISE EXCEPTION 'PR359_LOCAL_SEQUENCE_CREATION_ACL_DRIFT';
 END IF;
END;
$checks$;
ROLLBACK;
