-- Read-only Staging application row-content attestation.
-- This protects against equal-count row updates that the R4 count gate misses.
-- All 183 table hashes are taken within one repeatable-read transaction.
-- Does NOT claim a shared snapshot across the five independent CLI dumps.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle TO 'ISO, YMD';
SET LOCAL IntervalStyle TO 'postgres';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SELECT format(
  'SELECT jsonb_build_object(''schema'',%L,''table'',%L,''rows'',count(*)::bigint,'
  || '''content_sha256'',encode(extensions.digest(coalesce(string_agg('
  || 'encode(extensions.digest(to_jsonb(t)::text,''sha256''),''hex''),'
  || '''' ORDER BY encode(extensions.digest(to_jsonb(t)::text,''sha256''),''hex'')),'
  || ''''),''sha256''),''hex''))::text FROM %I.%I AS t',
  n.nspname,c.relname,n.nspname,c.relname
)
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','private','powerhub_private')
  AND c.relkind IN ('r','p') AND NOT c.relispartition
ORDER BY n.nspname,c.relname
\gexec
COMMIT;
