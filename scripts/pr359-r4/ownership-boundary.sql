-- R4 staging ownership boundary; metadata only, single SELECT, no mutations.
-- A postgres owner and no extension membership do NOT certify APP_OWNED.
WITH objects AS (
 SELECT 'relation' AS kind,n.nspname AS schema, c.relname AS name,
        c.oid AS oid, pg_get_userbyid(c.relowner) AS owner,
        EXISTS (SELECT 1 FROM pg_depend d
                WHERE d.classid='pg_class'::regclass
                AND d.objid=c.oid AND d.deptype='e') AS extension_owned
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
   AND c.relkind IN ('r','p','v','m','S')
 UNION ALL
 SELECT 'function',n.nspname,p.proname,p.oid,pg_get_userbyid(p.proowner),
        EXISTS (SELECT 1 FROM pg_depend d
                WHERE d.classid='pg_proc'::regclass
                AND d.objid=p.oid AND d.deptype='e')
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
), grouped AS (
 SELECT kind,schema,owner,extension_owned,count(*)::integer AS object_count
 FROM objects GROUP BY kind,schema,owner,extension_owned
), managed_edges AS (
 SELECT o.schema,o.kind,refns.nspname AS referenced_schema,d.deptype,count(*)::integer AS edges
 FROM objects o JOIN pg_depend d ON d.objid=o.oid
   AND d.classid=CASE WHEN o.kind='relation' THEN 'pg_class'::regclass ELSE 'pg_proc'::regclass END
 JOIN pg_class refrel ON refrel.oid=d.refobjid AND d.refclassid='pg_class'::regclass
 JOIN pg_namespace refns ON refns.oid=refrel.relnamespace
 WHERE d.classid IN ('pg_class'::regclass,'pg_proc'::regclass)
   AND refns.nspname IN ('auth','storage','realtime','vault','extensions','cron','net')
 GROUP BY o.schema,o.kind,refns.nspname,d.deptype
), managed_foreign_keys AS (
 -- Foreign keys belong to pg_constraint, not pg_class or pg_proc.
 -- The generic pg_depend scan above CANNOT be used to infer their absence.
 SELECT co.conname AS constraint_name, srcns.nspname AS source_schema,
        src.relname AS source_table, dstns.nspname AS target_schema,
        dst.relname AS target_table, co.convalidated AS validated,
        co.condeferrable AS deferrable, co.condeferred AS deferred
 FROM pg_constraint co
 JOIN pg_class src ON src.oid=co.conrelid
 JOIN pg_namespace srcns ON srcns.oid=src.relnamespace
 JOIN pg_class dst ON dst.oid=co.confrelid
 JOIN pg_namespace dstns ON dstns.oid=dst.relnamespace
 WHERE co.contype='f'
   AND srcns.nspname IN ('public','private','powerhub_private')
   AND dstns.nspname NOT IN ('public','private','powerhub_private')
)
SELECT jsonb_build_object(
 'scope','PR359_R4_STAGING_OWNERSHIP_BOUNDARY_V1',
 'owned_groups',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.kind,g.schema,g.owner),'[]'::jsonb) FROM grouped g),
 'managed_edges',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.schema,e.kind,e.referenced_schema),'[]'::jsonb) FROM managed_edges e),
 'managed_foreign_keys',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.source_schema,f.source_table,f.constraint_name),'[]'::jsonb) FROM managed_foreign_keys f),
 'cron_inventory',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',jobname,'schedule',schedule,'active',active) ORDER BY jobname),'[]'::jsonb) FROM cron.job),
 'app_trigger_count',(SELECT count(*) FROM pg_trigger t
   JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','private','powerhub_private') AND NOT t.tgisinternal),
 'app_rel_with_rls_no_policy',(SELECT count(*) FROM pg_class c
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p')
   AND c.relrowsecurity
   AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid))
)::text AS r4_ownership;
