-- R4 provider-managed -> application incoming dependencies. Catalog-only:
-- covers relations, functions, types and subobjects on the managed side.
-- A successful observation does NOT authorize APP_OWNED deletion or rebaseline.
WITH app_targets AS (
 SELECT 'pg_class'::regclass::oid AS catalog,c.oid AS oid,
        format('%I.%I',n.nspname,c.relname) AS identity
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 UNION ALL
 SELECT 'pg_proc'::regclass::oid,p.oid,
        format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 UNION ALL
 SELECT 'pg_type'::regclass::oid,t.oid,format('%I.%I',n.nspname,t.typname)
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
), managed_sources AS (
 SELECT 'pg_policy'::regclass::oid AS catalog,po.oid,
        n.nspname AS schema_name,format('%I.%I.%I',n.nspname,c.relname,po.polname) AS identity
 FROM pg_policy po JOIN pg_class c ON c.oid=po.polrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 UNION ALL
 SELECT 'pg_constraint'::regclass::oid,co.oid,n.nspname,
        format('%I.%I.%I',n.nspname,c.relname,co.conname)
 FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 UNION ALL
 SELECT 'pg_trigger'::regclass::oid,t.oid,n.nspname,format('%I.%I.%I',n.nspname,c.relname,t.tgname)
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 UNION ALL
 SELECT 'pg_rewrite'::regclass::oid,r.oid,n.nspname,format('%I.%I.%I',n.nspname,c.relname,r.rulename)
 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
 UNION ALL
 SELECT 'pg_attrdef'::regclass::oid,a.oid,n.nspname,format('%I.%I.%I',n.nspname,c.relname,at.attname)
 FROM pg_attrdef a JOIN pg_class c ON c.oid=a.adrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute at ON at.attrelid=c.oid AND at.attnum=a.adnum
 UNION ALL
 SELECT 'pg_proc'::regclass::oid,p.oid,n.nspname,
        format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 UNION ALL
 SELECT 'pg_class'::regclass::oid,c.oid,n.nspname,format('%I.%I',n.nspname,c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 UNION ALL
 SELECT 'pg_type'::regclass::oid,t.oid,n.nspname,format('%I.%I',n.nspname,t.typname)
 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
), edges AS (
 SELECT ms.catalog::regclass::text AS source_catalog,ms.schema_name AS source_schema,
        ms.identity AS source_object,at.catalog::regclass::text AS target_catalog,
        at.identity AS target_object,d.refobjsubid,d.deptype
 FROM managed_sources ms JOIN pg_depend d ON d.classid=ms.catalog AND d.objid=ms.oid
 JOIN app_targets at ON d.refclassid=at.catalog AND d.refobjid=at.oid
 WHERE ms.schema_name IN ('auth','storage','realtime','vault','extensions','cron','net',
                          'supabase_migrations','supabase_functions')
), grouped AS (
 SELECT source_catalog,source_schema,target_catalog,deptype,count(*)::integer AS edges
 FROM edges GROUP BY source_catalog,source_schema,target_catalog,deptype
)
SELECT count(*)::integer AS edge_count, encode(extensions.digest(coalesce(string_agg(jsonb_build_array(source_catalog,source_schema,source_object,target_catalog,target_object,refobjsubid,deptype)::text,E'\n' ORDER BY source_catalog,source_schema,source_object,target_catalog,target_object,refobjsubid,deptype),''),'sha256'),'hex') AS identity_sha256, jsonb_agg(to_jsonb(edges) ORDER BY source_catalog,source_schema,source_object,target_catalog,target_object,refobjsubid,deptype) AS edges FROM edges;