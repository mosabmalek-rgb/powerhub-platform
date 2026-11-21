-- R4: read-only attestation of essential Supabase-managed row data.
-- Auth accounts and identities; Storage bucket/object metadata.
-- Only count and SHA-256 leave the source, never plaintext rows or credentials.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle TO 'ISO, YMD';
SET LOCAL IntervalStyle TO 'postgres';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
-- Dollar-quoted SQL avoids malformed escaping in generated pgcrypto hashing.
SELECT format($managed_hash$
SELECT jsonb_build_object(
 'schema', %L, 'table', %L, 'rows', count(*)::bigint,
 'content_sha256', encode(extensions.digest(coalesce(string_agg(
  encode(extensions.digest(to_jsonb(t)::text, 'sha256'), 'hex'),
  '' ORDER BY encode(extensions.digest(to_jsonb(t)::text, 'sha256'), 'hex')
 ), ''), 'sha256'), 'hex')
)::text FROM %I.%I AS t
$managed_hash$,v.schema_name,v.table_name,v.schema_name,v.table_name)
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
