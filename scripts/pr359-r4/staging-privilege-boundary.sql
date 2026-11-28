-- Reviewed R4 privilege boundary omitted from seven existing-object catalogs.
-- Returns category/count/SHA256 only; no ACL grants, SQL bodies or user data.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog, public;
WITH inventory AS (
 SELECT 'schema'::text category,n.nspname AS identity,
 jsonb_build_object('owner',pg_get_userbyid(n.nspowner),
 'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(g.grantor),
 CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,
 g.privilege_type,g.is_grantable)
 ORDER BY pg_get_userbyid(g.grantor),
 CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,
 g.privilege_type,g.is_grantable),'[]'::jsonb)
 FROM aclexplode(coalesce(n.nspacl,acldefault('n'::"char",n.nspowner))) g)) attributes
 FROM pg_namespace n
 WHERE n.nspname IN ('public','private','powerhub_private')
 UNION ALL
 SELECT 'default_acl',pg_get_userbyid(d.defaclrole)||':'||
 coalesce(n.nspname,'<global>')||':'||d.defaclobjtype::text,
 jsonb_build_object('acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(g.grantor),
 CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,
 g.privilege_type,g.is_grantable)
 ORDER BY pg_get_userbyid(g.grantor),
 CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,
 g.privilege_type,g.is_grantable),'[]'::jsonb)
 FROM aclexplode(d.defaclacl) g))
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
 WHERE pg_get_userbyid(d.defaclrole)='postgres'
 AND (d.defaclnamespace=0 OR n.nspname IN ('public','private','powerhub_private'))
 UNION ALL
 SELECT 'column_acl',n.nspname||'.'||c.relname||'.'||quote_ident(a.attname),
 jsonb_build_object('acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(pg_get_userbyid(g.grantor),
 CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,
 g.privilege_type,g.is_grantable)
 ORDER BY pg_get_userbyid(g.grantor),
 CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,
 g.privilege_type,g.is_grantable),'[]'::jsonb)
 FROM aclexplode(a.attacl) g))
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
 AND c.relkind IN ('r','p','v','m','S')
 AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
), categories(category) AS (
 VALUES ('column_acl'::text),('default_acl'::text),('schema'::text)
)
SELECT jsonb_build_object('category',cat.category,'objects',count(i.identity)::bigint,
'sha256',encode(extensions.digest(coalesce(string_agg(
encode(extensions.digest(i.identity||chr(31)||i.attributes::text,'sha256'),'hex'),
'' ORDER BY i.identity),''),'sha256'),'hex'))::text
FROM categories cat LEFT JOIN inventory i ON i.category=cat.category
GROUP BY cat.category ORDER BY cat.category;
COMMIT;
