-- R4: render EXACT, source-snapshot-attested existing-object ACLs for
-- disposable PostgreSQL restores only. This emits SQL into a private runner
-- file; it never executes DDL on Staging or discloses business rows.
-- Source observations and destination restoration use separate connections.
-- Fail closed unless every in-scope owner/grantor/grantee is on the verified
-- closed allowlist. The canonical semantic ACL comparison still runs after replay.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog, public;
WITH objects AS (
 SELECT 'FUNCTION'::text AS object_kind,
   format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS identity,
   p.proowner AS owner_id,
   coalesce(p.proacl,acldefault('f'::"char",p.proowner)) AS object_acl
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','private','powerhub_private') AND p.prokind='f'
 UNION ALL
 SELECT CASE WHEN c.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,
   format('%I.%I',n.nspname,c.relname), c.relowner,
   coalesce(c.relacl,acldefault(
     CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private')
   AND c.relkind IN ('r','p','v','m','S')
), grants AS (
 SELECT o.object_kind,o.identity,o.owner_id,
   g.grantor,g.grantee,g.privilege_type,g.is_grantable
 FROM objects o CROSS JOIN LATERAL aclexplode(o.object_acl) AS g
), guard AS (
 SELECT 1 / CASE WHEN
   (SELECT count(*) > 0
      AND count(*) FILTER (WHERE pg_get_userbyid(owner_id)='postgres')=count(*)
    FROM objects)
   AND NOT EXISTS (
     SELECT 1 FROM grants g
     WHERE pg_get_userbyid(g.grantor) <> 'postgres'
        OR (g.grantee <> 0 AND
          pg_get_userbyid(g.grantee) NOT IN
            ('postgres','anon','authenticated','service_role'))
        OR (g.grantee=0 AND g.is_grantable)
   )
   THEN 1 ELSE 0 END AS ok
), reset_rows AS (
 SELECT 0 AS phase,object_kind,identity,''::text AS grantee,
   format('REVOKE ALL PRIVILEGES ON %s %s FROM PUBLIC, anon, authenticated, service_role;',
     object_kind,identity) AS statement
 FROM objects
), grant_rows AS (
 SELECT 1 AS phase,g.object_kind,g.identity,
   CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END AS grantee,
   format('GRANT %s ON %s %s TO %s%s;',
     string_agg(g.privilege_type,', ' ORDER BY g.privilege_type),
     g.object_kind,g.identity,
     CASE WHEN g.grantee=0 THEN 'PUBLIC'
          ELSE format('%I',pg_get_userbyid(g.grantee)) END,
     CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END) AS statement
 FROM grants g
 WHERE g.grantee=0 OR pg_get_userbyid(g.grantee)<>'postgres'
 GROUP BY g.object_kind,g.identity,g.grantee,g.is_grantable
)
SELECT statements.statement FROM (
 SELECT * FROM reset_rows UNION ALL SELECT * FROM grant_rows
) statements CROSS JOIN guard
WHERE guard.ok=1
ORDER BY statements.phase,statements.object_kind,statements.identity,statements.grantee;
COMMIT;
