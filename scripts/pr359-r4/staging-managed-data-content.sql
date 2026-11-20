-- R4: read-only attestation of essential Supabase-managed row data.
-- Auth account/identity records and Storage bucket/object metadata.
-- Never emits plaintext row values, credentials or password hashes.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle TO 'ISO, YMD';
SET LOCAL IntervalStyle TO 'postgres';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SELECT format(
 'SELECT jsonb_build_object(''schema'', %L, ''table'', %L, ''rows'', count(*)::bigint,'
 || '''content_sha256'', encode(extensions.digest(coalesce(string_agg('
 || 'encode(extensions.digest(to_jsonb(t)::text, ''sha256''),''hex''),'
 || '''' ORDER BY encode(extensions.digest(to_jsonb(t)::text,''sha256''),''hex'')),'
 || ''''),''sha256''),''hex''))::text FROM %I.%I AS t',
 v.schema_name,v.table_name,v.schema_name,v.table_name
)
FROM (VALUES
 ('auth','identities'),
 ('auth','users'),
 ('storage','buckets'),
 ('storage','objects')
) AS v(schema_name,table_name)
WHERE to_regclass(format('%I.%I',v.schema_name,v.table_name)) IS NOT NULL
ORDER BY v.schema_name,v.table_name
\gexec
COMMIT;
