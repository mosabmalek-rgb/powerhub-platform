-- PR359 R4: seven exact provider-owned policy definitions, read-only.
-- Imported into SAME exported MVCC source snapshot; never executes remotely.
-- Source fingerprint is independently pinned to a reviewed Staging observation.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog, public;
WITH policies AS (
 SELECT jsonb_build_object(
   'schema',n.nspname,'table',c.relname,'name',p.polname,
   'command',CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' ELSE 'UNSUPPORTED' END,
   'permissive',p.polpermissive,
   'roles',(SELECT coalesce(jsonb_agg(pg_get_userbyid(roles.role_oid) ORDER BY pg_get_userbyid(roles.role_oid)),'[]'::jsonb)
      FROM unnest(p.polroles) AS roles(role_oid)),
   'using',pg_get_expr(p.polqual,p.polrelid),
   'check',pg_get_expr(p.polwithcheck,p.polrelid)
 ) AS policy,
 n.nspname AS schema_name,c.relname AS relation_name,p.polname AS policy_name
 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname='realtime' AND c.relname='messages' AND p.polname IN
  ('chat_conversation_receive','chat_conversation_send',
   'chat_support_receive_conversation','chat_support_send_conversation',
   'chat_user_notification_receive','powerhub_delta_revision_receive'))
 OR (n.nspname='storage' AND c.relname='objects'
  AND p.polname='chat_storage_select_conversation_access')
), inventory AS (
 SELECT count(*) AS objects,
 encode(extensions.digest(coalesce(string_agg(policy::text,E'\n'
     ORDER BY schema_name,relation_name,policy_name),''),'sha256'),'hex') AS sha256,
 jsonb_agg(policy ORDER BY schema_name,relation_name,policy_name) AS policy_rows
 FROM policies
)
SELECT jsonb_build_object('format','PR359_R4_MANAGED_POLICY_REPLAY_V1',
 'sha256',sha256,'policies',policy_rows)::text
FROM inventory
WHERE objects=7
AND sha256='d74afb852ed0b498164be47f91c736f7a53538cad3f0bfd59b6e74e93352297d';
COMMIT;
