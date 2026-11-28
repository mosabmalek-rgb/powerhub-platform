-- PR359 R4 / Staging only. Read-only metadata attestation of 978 provisional candidates.
-- Catalog-structure hashes are NOT complete executable relation DDL.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog, public;
WITH functions AS (
 SELECT jsonb_build_object(
   'id',p.oid::regprocedure::text, 'kind','function', 'schema',n.nspname,
   'owner',pg_get_userbyid(p.proowner),
   'extension_name',coalesce((SELECT e.extname FROM pg_depend d
       JOIN pg_extension e ON e.oid=d.refobjid
       WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid
         AND d.refclassid='pg_extension'::regclass AND d.deptype='e'
       LIMIT 1),''),
   'definition_sha256',encode(extensions.digest(pg_get_functiondef(p.oid),'sha256'),'hex'),
   'acl_sha256',encode(extensions.digest(coalesce(p.proacl::text,''),'sha256'),'hex'),
   'security_definer',p.prosecdef,
   'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
   'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE')
 ) AS object
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','private','powerhub_private') AND p.prokind='f'
), relations AS (
 SELECT jsonb_build_object(
   'id',n.nspname||'.'||c.relname||'#'||c.relkind::text, 'kind','relation',
   'schema',n.nspname, 'relkind',c.relkind::text,
   'owner',pg_get_userbyid(c.relowner),
   'extension_name',coalesce((SELECT e.extname FROM pg_depend d
       JOIN pg_extension e ON e.oid=d.refobjid
       WHERE d.classid='pg_class'::regclass AND d.objid=c.oid
         AND d.refclassid='pg_extension'::regclass AND d.deptype='e'
       LIMIT 1),''),
   'acl_sha256',encode(extensions.digest(coalesce(c.relacl::text,''),'sha256'),'hex'),
   'rls',c.relrowsecurity, 'force_rls',c.relforcerowsecurity,
   'catalog_structure_not_full_ddl',true,
   'catalog_structure_sha256',encode(extensions.digest(
      jsonb_build_object(
        'relkind',c.relkind::text,'owner',pg_get_userbyid(c.relowner),
        'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
        'relacl',c.relacl::text,'reloptions',c.reloptions,
        'persistence',c.relpersistence,'partition',c.relispartition,
        'partition_bound',CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound,c.oid) ELSE NULL END,
        'viewdef',CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END,
        'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object(
             'number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
             'nullable',NOT a.attnotnull,'identity',a.attidentity,
             'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),
             'acl',a.attacl::text) ORDER BY a.attnum),'[]'::jsonb)
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
        'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object(
             'identity',i.indexrelid::regclass::text,'def',pg_get_indexdef(i.indexrelid),
             'valid',i.indisvalid,'ready',i.indisready) ORDER BY i.indexrelid::regclass::text),'[]'::jsonb)
          FROM pg_index i WHERE i.indrelid=c.oid),
        'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object(
             'identity',co.conname,'def',pg_get_constraintdef(co.oid,true),
             'validated',co.convalidated,'deferrable',co.condeferrable,
             'deferred',co.condeferred) ORDER BY co.conname),'[]'::jsonb)
          FROM pg_constraint co WHERE co.conrelid=c.oid),
        'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object(
             'identity',po.polname,'cmd',po.polcmd,'permissive',po.polpermissive,
             'using',pg_get_expr(po.polqual,po.polrelid),
             'check',pg_get_expr(po.polwithcheck,po.polrelid),
             'roles',(SELECT coalesce(jsonb_agg(pg_get_userbyid(r) ORDER BY pg_get_userbyid(r)),'[]'::jsonb)
                  FROM unnest(po.polroles) r)) ORDER BY po.polname),'[]'::jsonb)
          FROM pg_policy po WHERE po.polrelid=c.oid),
        'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object(
             'identity',t.tgname,'def',pg_get_triggerdef(t.oid,true),
             'enabled',t.tgenabled) ORDER BY t.tgname),'[]'::jsonb)
          FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
        'sequence',(SELECT to_jsonb(s)-'seqrelid'-'seqtypid'||
              jsonb_build_object('type',format_type(s.seqtypid,NULL))
              FROM pg_sequence s WHERE s.seqrelid=c.oid),
        'parent_relations',(SELECT coalesce(jsonb_agg(ip.inhparent::regclass::text
              ORDER BY ip.inhparent::regclass::text),'[]'::jsonb)
              FROM pg_inherits ip WHERE ip.inhrelid=c.oid)
      )::text,'sha256'),'hex')
 ) AS object
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private') AND c.relkind IN ('r','p','v','m','S')
), objects AS (
 SELECT object FROM functions UNION ALL SELECT object FROM relations
), verified AS (
 SELECT count(*) AS total,
        count(*) FILTER (WHERE object->>'kind'='function') AS fn_total,
        count(*) FILTER (WHERE object->>'kind'='relation') AS rel_total,
        count(DISTINCT object->>'id') AS distinct_ids,
        jsonb_agg(object ORDER BY object->>'id') AS items
 FROM objects
)
SELECT jsonb_build_object(
 'format','PR359_R4_STAGING_LIVE_OWNERSHIP_FINGERPRINTS_V1',
 'project_ref','iyuryuhaylhisjfcrwkz',
 'capture_mode','single-transaction-repeatable-read-read-only',
 'captured_at',transaction_timestamp()::text,
 'source_ref_review_head','3a296b6a49343fc64d909ea4b372959de8e86141',
 'object_count',total,'function_count',fn_total,'relation_count',rel_total,
 'unique_identity_count',distinct_ids,
 'relation_hash_scope','catalog-structure-only-not-complete-executable-DDL',
 'objects',items
)::text AS catalog
FROM verified
WHERE total=978 AND fn_total=641 AND rel_total=337 AND distinct_ids=978;
COMMIT;