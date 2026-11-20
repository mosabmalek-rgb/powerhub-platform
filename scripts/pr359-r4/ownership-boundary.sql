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

), managed_subobjects AS (
 -- pg_depend on subobjects (constraint, policy, rewrite, trigger, default)
 -- is invisible to scans limited to pg_class/pg_proc object IDs.
 SELECT 'pg_constraint'::regclass::oid AS classid,co.oid AS objid FROM pg_constraint co
 JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 UNION ALL SELECT 'pg_policy'::regclass::oid,po.oid FROM pg_policy po
 JOIN pg_class c ON c.oid=po.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 UNION ALL SELECT 'pg_rewrite'::regclass::oid,r.oid FROM pg_rewrite r
 JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 UNION ALL SELECT 'pg_trigger'::regclass::oid,t.oid FROM pg_trigger t
 JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private') AND NOT t.tgisinternal
 UNION ALL SELECT 'pg_attrdef'::regclass::oid,a.oid FROM pg_attrdef a
 JOIN pg_class c ON c.oid=a.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
), managed_subobject_edges AS (
 SELECT s.classid::regclass::text AS source_catalog,d.refclassid::regclass::text AS target_catalog,
        d.deptype,coalesce(rn.nspname,pn.nspname,tn.nspname,ns.nspname) AS target_schema
 FROM managed_subobjects s JOIN pg_depend d ON d.classid=s.classid AND d.objid=s.objid
 LEFT JOIN pg_class rc ON d.refclassid='pg_class'::regclass AND rc.oid=d.refobjid
 LEFT JOIN pg_namespace rn ON rn.oid=rc.relnamespace
 LEFT JOIN pg_proc rp ON d.refclassid='pg_proc'::regclass AND rp.oid=d.refobjid
 LEFT JOIN pg_namespace pn ON pn.oid=rp.pronamespace
 LEFT JOIN pg_type rt ON d.refclassid='pg_type'::regclass AND rt.oid=d.refobjid
 LEFT JOIN pg_namespace tn ON tn.oid=rt.typnamespace
 LEFT JOIN pg_namespace ns ON d.refclassid='pg_namespace'::regclass AND ns.oid=d.refobjid
), managed_subobject_dependencies AS (
 SELECT source_catalog,target_catalog,target_schema,deptype,count(*)::integer AS edges
 FROM managed_subobject_edges
 WHERE target_schema IN ('auth','storage','realtime','vault','extensions','cron','net','supabase_migrations','supabase_functions')
 GROUP BY source_catalog,target_catalog,target_schema,deptype
), managed_policy_functions AS (
 -- Identity check prevents a different managed Auth function replacing an
 -- existing dependency while leaving aggregate counts unchanged.
 SELECT n.nspname AS source_schema,c.relname AS source_table,po.polname AS policy_name,
 pn.nspname AS target_schema,
 format('%I.%I(%s)',pn.nspname,rp.proname,pg_get_function_identity_arguments(rp.oid)) AS target_function,
 d.deptype AS dependency_type
 FROM pg_policy po JOIN pg_class c ON c.oid=po.polrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_depend d ON d.classid='pg_policy'::regclass AND d.objid=po.oid
 JOIN pg_proc rp ON rp.oid=d.refobjid AND d.refclassid='pg_proc'::regclass
 JOIN pg_namespace pn ON pn.oid=rp.pronamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 AND pn.nspname IN ('auth','storage','realtime','vault','extensions','cron','net','supabase_migrations','supabase_functions')
)
SELECT jsonb_build_object(
 'scope','PR359_R4_STAGING_OWNERSHIP_BOUNDARY_V1',
 'owned_groups',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.kind,g.schema,g.owner),'[]'::jsonb) FROM grouped g),
 'managed_edges',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.schema,e.kind,e.referenced_schema),'[]'::jsonb) FROM managed_edges e),
 'managed_foreign_keys',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.source_schema,f.source_table,f.constraint_name),'[]'::jsonb) FROM managed_foreign_keys f),
 'managed_subobject_dependencies',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.source_catalog,x.target_catalog,x.target_schema,x.deptype),'[]'::jsonb) FROM managed_subobject_dependencies x),
 'managed_policy_functions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.source_schema,x.source_table,x.policy_name,x.target_function),'[]'::jsonb) FROM managed_policy_functions x),
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
