-- Provider-managed relation topology only. No business rows, Auth identities or credentials.
-- Dynamic Realtime message partitions are recorded but are not assumed identical across environments.
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'schema',n.nspname,'table',c.relname,
  'kind',c.relkind::text,'owner',pg_get_userbyid(c.relowner),
  'is_partition',c.relispartition,
  'parent',(SELECT pn.nspname||'.'||pc.relname
            FROM pg_inherits i
            JOIN pg_class pc ON pc.oid=i.inhparent
            JOIN pg_namespace pn ON pn.oid=pc.relnamespace
            WHERE i.inhrelid=c.oid LIMIT 1),
  'partition_bound',CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound,c.oid) ELSE NULL END
) ORDER BY n.nspname,c.relname),'[]'::jsonb)::text
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('auth','storage','realtime') AND c.relkind IN ('r','p');
