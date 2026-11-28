-- Disposable local stack only: provider-managed Iceberg catalog metadata.
-- No source credentials, business rows, Auth identities or SQL modifications.
WITH rel AS (
 SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
        pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls_enabled,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policy_count,
        (SELECT coalesce(jsonb_agg(k.confrelid::regclass::text ORDER BY k.conname),'[]'::jsonb)
         FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='f') AS outgoing_fks,
        (SELECT coalesce(jsonb_agg(k.conrelid::regclass::text ORDER BY k.conname),'[]'::jsonb)
         FROM pg_constraint k WHERE k.confrelid=c.oid AND k.contype='f') AS incoming_fks,
        CASE WHEN to_regrole('anon') IS NULL THEN NULL ELSE
          has_table_privilege('anon',c.oid,'INSERT') OR
          has_table_privilege('anon',c.oid,'UPDATE') OR
          has_table_privilege('anon',c.oid,'DELETE') END AS anon_writes,
        CASE WHEN to_regrole('authenticated') IS NULL THEN NULL ELSE
          has_table_privilege('authenticated',c.oid,'INSERT') OR
          has_table_privilege('authenticated',c.oid,'UPDATE') OR
          has_table_privilege('authenticated',c.oid,'DELETE') END AS authenticated_writes
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='storage' AND c.relkind IN ('r','p')
   AND c.relname IN ('buckets_analytics','iceberg_namespaces','iceberg_tables')
)
SELECT jsonb_build_object(
 'scope','PR359_LOCAL_ICEBERG_ONLY',
 'migration_names',(SELECT coalesce(jsonb_agg(m.name ORDER BY m.id),'[]'::jsonb)
   FROM storage.migrations m WHERE m.name IN
   ('iceberg-catalog-flag-on-buckets','iceberg-table-metadata','iceberg-catalog-ids')),
 'relations',(SELECT coalesce(jsonb_agg(to_jsonb(rel) ORDER BY rel.name),'[]'::jsonb) FROM rel)
)::text;
