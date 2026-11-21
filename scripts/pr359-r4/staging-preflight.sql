-- PR359 R4 staging-only: single-statement, read-only inventory.
-- Never run DROP/DELETE/TRUNCATE/ALTER, never export secrets or row-level user data.
-- This is an observation, NOT a cleanup candidate list or execution authorization.
WITH app_rel AS (
 SELECT n.nspname,c.relkind,c.relname,c.oid
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
   AND c.relkind IN ('r','p','v','m','S')
), auth_fks AS (
 SELECT tgt.conname AS name, srcns.nspname AS source_schema,
        src.relname AS source_relation, dstns.nspname AS referenced_schema,
        dst.relname AS referenced_relation
 FROM pg_constraint tgt
 JOIN pg_class src ON src.oid=tgt.conrelid
 JOIN pg_namespace srcns ON srcns.oid=src.relnamespace
 JOIN pg_class dst ON dst.oid=tgt.confrelid
 JOIN pg_namespace dstns ON dstns.oid=dst.relnamespace
 WHERE tgt.contype='f'
   AND srcns.nspname IN ('public','private','powerhub_private')
   AND dstns.nspname IN ('auth','storage','realtime','vault')
), auth_triggers AS (
 SELECT t.tgname AS name FROM pg_trigger t
 WHERE t.tgrelid='auth.users'::regclass AND NOT t.tgisinternal
), exposed_defs AS (
 SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
   AND p.prosecdef
   AND has_function_privilege('authenticated',p.oid,'EXECUTE')
   AND has_schema_privilege('authenticated',n.oid,'USAGE')
)
SELECT jsonb_build_object(
 'app_relations',(SELECT jsonb_object_agg(nspname,total) FROM
                  (SELECT nspname,count(*) AS total FROM app_rel GROUP BY nspname) t),
 'app_extension_members',(SELECT count(*) FROM pg_depend d JOIN app_rel a
                         ON a.oid=d.objid WHERE d.deptype='e'),
 'app_managed_foreign_keys',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.name),'[]'::jsonb)
                             FROM auth_fks f),
 'auth_user_noninternal_triggers',(SELECT coalesce(jsonb_agg(name ORDER BY name),'[]'::jsonb)
                                   FROM auth_triggers),
 'authenticated_security_definer_exposed_count',(SELECT count(*) FROM exposed_defs),
 'auth_user_count',(SELECT count(*) FROM auth.users),
 'storage_object_metadata_count',(SELECT count(*) FROM storage.objects),
 'storage_bucket_count',(SELECT count(*) FROM storage.buckets),
 'migration_history_count',(SELECT count(*) FROM supabase_migrations.schema_migrations),
 'migration_latest_version',(SELECT max(version) FROM supabase_migrations.schema_migrations),
 'app_cron_job_count',(SELECT count(*) FROM cron.job)
)::text AS r4_metadata;
