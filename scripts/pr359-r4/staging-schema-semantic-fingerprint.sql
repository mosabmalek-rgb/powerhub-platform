-- Staging-only canonical semantic parity; retains ALL seven application catalog
-- categories. ACLs are normalized by *role name*, grantor, grantee, privilege
-- and grant option; no privilege grant is ignored. Use acldefault() for NULL
-- ACLs, and use live column NAMES rather than the physical attnum changed by
-- dropped legacy columns. Role metadata, RLS, source review, raw differences,
-- FK and content gates still run independently.
-- R4: full application-namespace structural SHA-256, source/restore parity.
-- Only catalog metadata; no customer values, role secrets, DML or DDL.
-- BEGIN/COMMIT are stripped by the Staging shared-snapshot query importer.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog, public;
WITH inventory AS (
 SELECT 'functions'::text AS category, n.nspname||'.'||p.oid::regprocedure::text AS identity,
 jsonb_build_object('def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(acl.grantor),CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,acl.privilege_type,acl.is_grantable) ORDER BY pg_get_userbyid(acl.grantor),CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,acl.privilege_type,acl.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(p.proacl,acldefault('f'::"char",p.proowner))) AS acl),'security_definer',p.prosecdef) AS attributes
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','private','powerhub_private') AND p.prokind='f'
 UNION ALL
 SELECT 'relations',n.nspname||'.'||c.relname,
 jsonb_build_object('kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(acl.grantor),CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,acl.privilege_type,acl.is_grantable) ORDER BY pg_get_userbyid(acl.grantor),CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END,acl.privilege_type,acl.is_grantable),'[]'::jsonb) FROM aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) AS acl),'options',c.reloptions)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private') AND c.relkind IN ('r','p','v','m','S')
 UNION ALL
 SELECT 'columns',n.nspname||'.'||c.relname||'.'||quote_ident(a.attname),
 jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'nullable',NOT a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid))
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE n.nspname IN ('public','private','powerhub_private') AND c.relkind IN ('r','p','v','m','S') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL
 SELECT 'indexes',n.nspname||'.'||t.relname||'.'||idx.relname,
 jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready)
 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
 JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_namespace n ON n.oid=t.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 UNION ALL
 SELECT 'constraints',n.nspname||'.'||t.relname||'.'||c.conname,
 jsonb_build_object('definition',pg_get_constraintdef(c.oid,true),'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred)
 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 UNION ALL
 SELECT 'policies',n.nspname||'.'||c.relname||'.'||p.polname,
 jsonb_build_object('using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid),'cmd',p.polcmd,'permissive',p.polpermissive,'roles',
 (SELECT coalesce(jsonb_agg(pg_get_userbyid(r) ORDER BY pg_get_userbyid(r)),'[]'::jsonb) FROM unnest(p.polroles) r))
 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 UNION ALL
 SELECT 'triggers',n.nspname||'.'||c.relname||'.'||t.tgname,
 jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text)
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private') AND NOT t.tgisinternal
)
SELECT jsonb_build_object('category',category,'objects',count(*)::bigint,'sha256',
 encode(extensions.digest(coalesce(string_agg(
 encode(extensions.digest(identity||E'\x1F'||attributes::text,'sha256'),'hex'),'' ORDER BY identity),''),'sha256'),'hex')
)::text
FROM inventory GROUP BY category ORDER BY category;
COMMIT;
