-- Enforce the same upload limits at the Storage service boundary as in server/storage.ts.
-- This is a metadata-only bucket update: no objects or policies are changed.

DO $preflight$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_STORAGE_BUCKETS_TABLE_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'powerhub-private'
  ) THEN
    RAISE EXCEPTION 'POWERHUB_PRIVATE_STORAGE_BUCKET_MISSING';
  END IF;
END
$preflight$;

UPDATE storage.buckets
SET
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
  ]::text[]
WHERE id = 'powerhub-private';

DO $postflight$
DECLARE
  v_file_size_limit bigint;
  v_allowed_mime_types text[];
BEGIN
  SELECT file_size_limit, allowed_mime_types
    INTO v_file_size_limit, v_allowed_mime_types
  FROM storage.buckets
  WHERE id = 'powerhub-private';

  IF v_file_size_limit IS DISTINCT FROM 10485760::bigint THEN
    RAISE EXCEPTION 'POWERHUB_STORAGE_FILE_SIZE_LIMIT_MISMATCH: %', v_file_size_limit;
  END IF;

  IF v_allowed_mime_types IS DISTINCT FROM ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
  ]::text[] THEN
    RAISE EXCEPTION 'POWERHUB_STORAGE_MIME_ALLOW_LIST_MISMATCH: %', v_allowed_mime_types;
  END IF;
END
$postflight$;
