-- PR359 R4: application foreign-key edges into provider-managed Supabase namespaces.
-- Metadata-only, read-only, shared-snapshot compatible.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
 'name',co.conname,
 'source_schema',n.nspname,
 'source_table',c.relname,
 'target_schema',rn.nspname,
 'target_table',r.relname,
 'definition_sha256',encode(extensions.digest(pg_get_constraintdef(co.oid,true),'sha256'),'hex'),
 'validated',co.convalidated,
 'deferrable',co.condeferrable,
 'deferred',co.condeferred
)::text
FROM pg_constraint co
JOIN pg_class c ON c.oid=co.conrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_class r ON r.oid=co.confrelid
JOIN pg_namespace rn ON rn.oid=r.relnamespace
WHERE co.contype='f'
  AND n.nspname IN ('public','private','powerhub_private')
  AND rn.nspname IN ('auth','storage','realtime','cron','extensions','supabase_migrations')
ORDER BY n.nspname,c.relname,co.conname;
COMMIT;
