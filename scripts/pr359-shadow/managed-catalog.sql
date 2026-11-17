-- Metadata only: no user records, secrets or source data.
SELECT coalesce(jsonb_agg(
  jsonb_build_object(
    'schema', n.nspname,
    'table', c.relname,
    'column', a.attname,
    'type', pg_catalog.format_type(a.atttypid,a.atttypmod)
  ) ORDER BY n.nspname,c.relname,a.attnum
), '[]'::jsonb)::text
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
WHERE n.nspname IN ('auth','storage','realtime')
  AND c.relkind IN ('r','p')
  AND a.attnum > 0 AND NOT a.attisdropped;
