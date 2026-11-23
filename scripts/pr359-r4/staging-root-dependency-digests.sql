-- PR359 R4: read-only, identity-stable PostgreSQL dependency adjacency digest.
-- APP_OWNED candidates are NOT approved; this audit never emits DDL/DML.
-- pg_depend alone is NOT a proof against dynamic SQL, runtime callers or
-- provider-owned subobject dependencies, checked separately by existing R4.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog, public;
WITH roots AS (
 SELECT 'pg_class'::regclass::oid AS classid,c.oid AS objid,
   n.nspname||'.'||c.relname||'#'||c.relkind::text AS identity,
   'relation'::text AS kind
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','private','powerhub_private') AND c.relkind IN ('r','p','v','m','S')
 UNION ALL
 SELECT 'pg_proc'::regclass::oid,p.oid,p.oid::regprocedure::text,
   'function'::text
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','private','powerhub_private') AND p.prokind='f'
), adjacency AS (
 SELECT a.identity,'incoming'::text AS direction,
   jsonb_build_object(
     'peer_catalog',d.classid::regclass::text,
     'peer_type',src.type,'peer_schema',src.schema,'peer_identity',src.identity,
     'peer_subid',d.objsubid,'root_subid',d.refobjsubid,'dependency',d.deptype
   ) AS edge,src.schema AS peer_schema,src.identity AS peer_identity
 FROM roots a JOIN pg_depend d ON d.refclassid=a.classid AND d.refobjid=a.objid
 CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) src
 UNION ALL
 SELECT a.identity,'outgoing',
   jsonb_build_object(
     'peer_catalog',d.refclassid::regclass::text,
     'peer_type',target.type,'peer_schema',target.schema,'peer_identity',target.identity,
     'peer_subid',d.refobjsubid,'root_subid',d.objsubid,'dependency',d.deptype
   ),target.schema,target.identity
 FROM roots a JOIN pg_depend d ON d.classid=a.classid AND d.objid=a.objid
 CROSS JOIN LATERAL pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) target
), summary AS (
 SELECT identity,direction,
   count(*)::int AS edge_count,
   count(*) FILTER (WHERE peer_schema IN (
      'auth','storage','realtime','vault','extensions','cron','net',
      'supabase_migrations','supabase_functions'))::int AS managed_peer_edges,
   count(*) FILTER (WHERE peer_identity IS NULL)::int AS unidentified_peer_edges,
   encode(extensions.digest(coalesce(string_agg(edge::text,E'\n'
      ORDER BY edge::text),''),'sha256'),'hex') AS sha256
 FROM adjacency GROUP BY identity,direction
), entries AS (
 SELECT r.identity,r.kind,
   coalesce(i.edge_count,0)::int AS incoming_edges,
   coalesce(o.edge_count,0)::int AS outgoing_edges,
   coalesce(i.managed_peer_edges,0)::int AS managed_incoming,
   coalesce(o.managed_peer_edges,0)::int AS managed_outgoing,
   coalesce(i.unidentified_peer_edges,0)::int AS unidentified_incoming,
   coalesce(o.unidentified_peer_edges,0)::int AS unidentified_outgoing,
   coalesce(i.sha256,encode(extensions.digest('','sha256'),'hex')) AS incoming_sha256,
   coalesce(o.sha256,encode(extensions.digest('','sha256'),'hex')) AS outgoing_sha256
 FROM roots r LEFT JOIN summary i ON i.identity=r.identity AND i.direction='incoming'
 LEFT JOIN summary o ON o.identity=r.identity AND o.direction='outgoing'
), checkall AS (
 SELECT count(*)::int AS roots,
   count(DISTINCT identity)::int AS distinct_roots,
   count(*) FILTER (WHERE kind='function')::int AS funcs,
   count(*) FILTER (WHERE kind='relation')::int AS rels,
   sum(incoming_edges)::int AS incoming_edges,
   sum(outgoing_edges)::int AS outgoing_edges,
   sum(managed_incoming)::int AS managed_incoming,
   sum(managed_outgoing)::int AS managed_outgoing,
   sum(unidentified_incoming)::int AS unidentified_incoming,
   sum(unidentified_outgoing)::int AS unidentified_outgoing,
   jsonb_agg(to_jsonb(entries) ORDER BY identity) AS rows
 FROM entries
)
SELECT jsonb_build_object(
  'format','PR359_R4_STAGING_ROOT_DEPENDENCY_DIGESTS_V1',
  'project_ref','iyuryuhaylhisjfcrwkz',
  'capture_mode','repeatable-read-read-only',
  'captured_at',transaction_timestamp()::text,
  'source_review_head','a8bdad79884a25ab74dfa810f9f14b0fd5e6b85c',
  'scope','pg_depend root adjacency only; managed subobject dependencies are separately checked',
  'root_count',roots,'unique_root_count',distinct_roots,
  'function_count',funcs,'relation_count',rels,
  'incoming_edge_count',incoming_edges,'outgoing_edge_count',outgoing_edges,
  'managed_incoming_count',managed_incoming,'managed_outgoing_count',managed_outgoing,
  'unidentified_incoming_count',unidentified_incoming,
  'unidentified_outgoing_count',unidentified_outgoing,
  'application_ownership_approved',false,'destructive_allowlist','[]'::jsonb,
  'entries',rows
)::text AS dependency_snapshot
FROM checkall WHERE roots=978 AND distinct_roots=978 AND funcs=641 AND rels=337;
COMMIT;
