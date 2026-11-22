-- R4 diagnostic-only grant census. Runs on source MVCC snapshot and in
-- disposable restore. Counts EXISTING object grants without values or DDL.
-- Only built-in/known application role names are printed; unknown names
-- are masked as OTHER. Exact ACL semantic fingerprints remain authoritative.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog, public;
WITH grants AS (
 SELECT 'functions'::text AS category,n.nspname AS schema_name,p.oid AS object_oid,
  a.grantor,a.grantee,a.privilege_type,a.is_grantable
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f'::"char",p.proowner))) a
 WHERE n.nspname IN('public','private','powerhub_private') AND p.prokind='f'
 UNION ALL
 SELECT 'relations',n.nspname,c.oid,a.grantor,a.grantee,
  a.privilege_type,a.is_grantable
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,
  acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
 WHERE n.nspname IN('public','private','powerhub_private')
  AND c.relkind IN('r','p','v','m','S')
), grouped AS (
 SELECT category,schema_name,
  CASE WHEN pg_get_userbyid(grantor) IN ('postgres','anon','authenticated','service_role')
       THEN pg_get_userbyid(grantor) ELSE 'OTHER' END AS grantor_label,
  CASE WHEN grantee=0 THEN 'PUBLIC'
       WHEN pg_get_userbyid(grantee) IN ('postgres','anon','authenticated','service_role')
       THEN pg_get_userbyid(grantee) ELSE 'OTHER' END AS grantee_label,
  privilege_type,is_grantable,COUNT(DISTINCT object_oid)::integer AS objects
 FROM grants
 GROUP BY category,schema_name,grantor_label,grantee_label,privilege_type,is_grantable
)
SELECT jsonb_build_object('category',category,'schema',schema_name,
 'grantor',grantor_label,'grantee',grantee_label,'privilege',privilege_type,
 'grantable',is_grantable,'objects',objects)::text
FROM grouped ORDER BY category,schema_name,grantor_label,grantee_label,privilege_type,is_grantable;
COMMIT;
