-- PR359 disposable shadow and read-only hosted source attestation.
-- SQL reads the complete historical migration row, but returns ONLY hash/count
-- and min/max version. It never returns statements, rollback payloads or secrets.
SELECT jsonb_build_object(
  'row_count',(SELECT count(*) FROM supabase_migrations.schema_migrations),
  'min_version',(SELECT min(version) FROM supabase_migrations.schema_migrations),
  'max_version',(SELECT max(version) FROM supabase_migrations.schema_migrations),
  'whole_row_sha256',encode(extensions.digest(
    coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.version,m.name,m.idempotency_key)
      FROM supabase_migrations.schema_migrations m),'[]'::jsonb)::text,'sha256'),'hex')
)::text AS history_attestation;
