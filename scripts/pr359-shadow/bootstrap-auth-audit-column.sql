-- ONLY for isolated, networkless PR359 Docker Shadow. Never deploy as a Supabase migration.
-- Production catalog attested 2026-11-17: auth.audit_log_entries.ip_address
-- character varying NOT NULL DEFAULT ''::character varying.
DO $pr359_auth_compat$
BEGIN
  IF to_regclass('auth.audit_log_entries') IS NULL THEN
    RAISE EXCEPTION 'PR359_SHADOW_AUTH_AUDIT_TABLE_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'auth.audit_log_entries'::regclass
      AND attname = 'ip_address' AND attnum > 0 AND NOT attisdropped
  ) THEN
    ALTER TABLE auth.audit_log_entries
      ADD COLUMN ip_address character varying NOT NULL DEFAULT ''::character varying;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'audit_log_entries'
      AND column_name = 'ip_address' AND data_type = 'character varying'
      AND is_nullable = 'NO' AND column_default = $$''::character varying$$
  ) THEN
    RAISE EXCEPTION 'PR359_SHADOW_AUTH_AUDIT_IP_COLUMN_MISMATCH';
  END IF;
END
$pr359_auth_compat$;
