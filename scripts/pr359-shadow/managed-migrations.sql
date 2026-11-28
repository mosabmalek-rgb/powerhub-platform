-- Read-only, metadata-only provider-managed service migration provenance.
-- Use the identical query on hosted source and on the disposable local stack.
-- Do not include business rows, Auth identities or SQL dump contents.
SELECT coalesce(
  jsonb_agg(
    jsonb_build_object('service', svc, 'version', version, 'checksum', checksum)
    ORDER BY svc, version
  ),
  '[]'::jsonb
)::text
FROM (
  SELECT 'auth'::text AS svc, version::text AS version, NULL::text AS checksum
    FROM auth.schema_migrations
  UNION ALL
  SELECT 'storage', name::text, hash::text
    FROM storage.migrations
  UNION ALL
  SELECT 'realtime', version::text, NULL::text
    FROM realtime.schema_migrations
) AS managed_history;
