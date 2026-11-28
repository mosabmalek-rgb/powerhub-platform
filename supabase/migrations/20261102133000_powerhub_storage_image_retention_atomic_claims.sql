-- Atomic, server-only image-reference cleanup with leases for concurrent retention workers.
-- Files are claimed and all database references are reconciled in one PostgreSQL transaction.
-- The caller then uses Supabase Storage API and finalizes or releases the lease.

DO $dependencies$
DECLARE
  v_missing text[];
BEGIN
  SELECT pg_catalog.array_agg(required.column_name ORDER BY required.table_name, required.column_name)
  INTO v_missing
  FROM (
    VALUES
      ('payment_documentation_requests', 'receipt_image_key'),
      ('payment_documentation_requests', 'receipt_image_deleted_at'),
      ('payment_documentation_requests', 'receipt_image_retention_until'),
      ('payment_documentation_requests', 'updated_at'),
      ('payments', 'receipt_image_key'),
      ('meter_readings', 'image_key'),
      ('chat_message_attachments', 'storage_bucket'),
      ('chat_message_attachments', 'storage_path'),
      ('chat_message_attachments', 'storage_deleted_at')
  ) AS required(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS column_row
    WHERE column_row.table_schema = 'public'
      AND column_row.table_name = required.table_name
      AND column_row.column_name = required.column_name
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'STORAGE_IMAGE_RETENTION_SCHEMA_DEPENDENCY_MISSING: %', v_missing;
  END IF;
END
$dependencies$;

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.powerhub_storage_image_retention_claims (
  storage_bucket text NOT NULL DEFAULT 'powerhub-private'
    CHECK (storage_bucket = 'powerhub-private'),
  storage_path text NOT NULL
    CHECK (storage_path ~* '^(payment-receipts|subscriber-readings|chat)/.+\.(avif|apng|bmp|gif|heic|heif|ico|jpe?g|jfif|png|svg|tif|tiff|webp)$'),
  claim_token uuid,
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  storage_deleted_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT powerhub_storage_image_retention_claims_pk
    PRIMARY KEY (storage_bucket, storage_path),
  CONSTRAINT powerhub_storage_image_retention_claim_lease_check
    CHECK ((claim_token IS NULL) = (lease_until IS NULL))
);

ALTER TABLE private.powerhub_storage_image_retention_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.powerhub_storage_image_retention_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE private.powerhub_storage_image_retention_claims OWNER TO postgres;
REVOKE ALL ON TABLE private.powerhub_storage_image_retention_claims FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE private.powerhub_storage_image_retention_claims IS
  'Internal per-object 15-day Storage image-retention claims. No user data or file contents are stored.';

CREATE OR REPLACE FUNCTION public.powerhub_claim_storage_image_retention_objects(
  p_object_keys text[],
  p_claim_token uuid,
  p_claimed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_claimed_keys text[] := ARRAY[]::text[];
  v_payment_documentation_requests bigint := 0;
  v_payments bigint := 0;
  v_meter_readings bigint := 0;
  v_chat_attachments bigint := 0;
BEGIN
  IF coalesce(pg_catalog.current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  IF p_claim_token IS NULL OR p_claimed_at IS NULL
     OR p_object_keys IS NULL
     OR pg_catalog.cardinality(p_object_keys) < 1
     OR pg_catalog.cardinality(p_object_keys) > 1000 THEN
    RAISE EXCEPTION 'INVALID_STORAGE_IMAGE_RETENTION_CLAIM';
  END IF;

  IF pg_catalog.cardinality(p_object_keys) <> (
    SELECT pg_catalog.count(DISTINCT supplied.object_key)
    FROM pg_catalog.unnest(p_object_keys) AS supplied(object_key)
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_STORAGE_IMAGE_RETENTION_KEY';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_object_keys) AS supplied(object_key)
    WHERE supplied.object_key IS NULL
       OR supplied.object_key = ''
       OR supplied.object_key <> pg_catalog.btrim(supplied.object_key)
       OR pg_catalog.length(supplied.object_key) > 1024
       OR pg_catalog.left(supplied.object_key, 1) = '/'
       OR pg_catalog.right(supplied.object_key, 1) = '/'
       OR pg_catalog.strpos(supplied.object_key, '//') > 0
       OR pg_catalog.strpos(supplied.object_key, pg_catalog.chr(92)) > 0
       OR supplied.object_key ~ '(^|/)\.{1,2}(/|$)'
       OR pg_catalog.split_part(supplied.object_key, '/', 1)
          NOT IN ('payment-receipts', 'subscriber-readings', 'chat')
       OR supplied.object_key !~* '\.(avif|apng|bmp|gif|heic|heif|ico|jpe?g|jfif|png|svg|tif|tiff|webp)$'
  ) THEN
    RAISE EXCEPTION 'INVALID_STORAGE_IMAGE_RETENTION_KEY';
  END IF;

  -- An upsert with a lease prevents two workers from detaching/deleting the same
  -- object at the same time. Expired leases are reclaimable after worker failure.
  WITH claimed AS (
    INSERT INTO private.powerhub_storage_image_retention_claims AS existing (
      storage_bucket,
      storage_path,
      claim_token,
      lease_until,
      attempt_count,
      last_error_code,
      created_at,
      updated_at
    )
    SELECT
      'powerhub-private',
      supplied.object_key,
      p_claim_token,
      p_claimed_at + interval '15 minutes',
      1,
      NULL,
      p_claimed_at,
      p_claimed_at
    FROM pg_catalog.unnest(p_object_keys) AS supplied(object_key)
    ORDER BY supplied.object_key
    ON CONFLICT (storage_bucket, storage_path) DO UPDATE
    SET
      claim_token = EXCLUDED.claim_token,
      lease_until = EXCLUDED.lease_until,
      attempt_count = existing.attempt_count + 1,
      last_error_code = NULL,
      updated_at = EXCLUDED.updated_at
    WHERE existing.storage_deleted_at IS NULL
      AND (existing.claim_token IS NULL OR existing.lease_until <= p_claimed_at)
    RETURNING storage_path
  )
  SELECT coalesce(
    pg_catalog.array_agg(claimed.storage_path ORDER BY claimed.storage_path),
    ARRAY[]::text[]
  )
  INTO v_claimed_keys
  FROM claimed;

  IF pg_catalog.cardinality(v_claimed_keys) > 0 THEN
    -- These four updates are part of this function call's single database transaction.
    UPDATE public.payment_documentation_requests
    SET
      receipt_image_key = NULL,
      receipt_image_deleted_at = p_claimed_at,
      receipt_image_retention_until = p_claimed_at,
      updated_at = p_claimed_at
    WHERE receipt_image_key = ANY(v_claimed_keys);
    GET DIAGNOSTICS v_payment_documentation_requests = ROW_COUNT;

    UPDATE public.payments
    SET receipt_image_key = NULL
    WHERE receipt_image_key = ANY(v_claimed_keys);
    GET DIAGNOSTICS v_payments = ROW_COUNT;

    UPDATE public.meter_readings
    SET image_key = NULL
    WHERE image_key = ANY(v_claimed_keys);
    GET DIAGNOSTICS v_meter_readings = ROW_COUNT;

    UPDATE public.chat_message_attachments
    SET storage_deleted_at = coalesce(storage_deleted_at, p_claimed_at)
    WHERE storage_bucket = 'powerhub-private'
      AND storage_path = ANY(v_claimed_keys)
      AND storage_deleted_at IS NULL;
    GET DIAGNOSTICS v_chat_attachments = ROW_COUNT;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'claimedKeys', pg_catalog.to_jsonb(v_claimed_keys),
    'referencesDetached', pg_catalog.jsonb_build_object(
      'paymentDocumentationRequests', v_payment_documentation_requests,
      'payments', v_payments,
      'meterReadings', v_meter_readings,
      'chatAttachments', v_chat_attachments
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_finish_storage_image_retention_objects(
  p_object_keys text[],
  p_claim_token uuid,
  p_removed boolean,
  p_finished_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_affected bigint := 0;
BEGIN
  IF coalesce(pg_catalog.current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'INTERNAL_ONLY';
  END IF;

  IF p_claim_token IS NULL OR p_removed IS NULL OR p_finished_at IS NULL
     OR p_object_keys IS NULL
     OR pg_catalog.cardinality(p_object_keys) < 1
     OR pg_catalog.cardinality(p_object_keys) > 1000 THEN
    RAISE EXCEPTION 'INVALID_STORAGE_IMAGE_RETENTION_FINISH';
  END IF;

  IF p_removed THEN
    UPDATE private.powerhub_storage_image_retention_claims
    SET
      storage_deleted_at = p_finished_at,
      claim_token = NULL,
      lease_until = NULL,
      last_error_code = NULL,
      updated_at = p_finished_at
    WHERE storage_bucket = 'powerhub-private'
      AND storage_path = ANY(p_object_keys)
      AND claim_token = p_claim_token
      AND storage_deleted_at IS NULL;
  ELSE
    UPDATE private.powerhub_storage_image_retention_claims
    SET
      claim_token = NULL,
      lease_until = NULL,
      last_error_code = 'storage_remove_failed',
      updated_at = p_finished_at
    WHERE storage_bucket = 'powerhub-private'
      AND storage_path = ANY(p_object_keys)
      AND claim_token = p_claim_token
      AND storage_deleted_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_affected = ROW_COUNT;

  RETURN CASE
    WHEN p_removed THEN pg_catalog.jsonb_build_object('finishedCount', v_affected)
    ELSE pg_catalog.jsonb_build_object('releasedCount', v_affected)
  END;
END;
$function$;

ALTER FUNCTION public.powerhub_claim_storage_image_retention_objects(text[], uuid, timestamptz) OWNER TO postgres;
ALTER FUNCTION public.powerhub_finish_storage_image_retention_objects(text[], uuid, boolean, timestamptz) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.powerhub_claim_storage_image_retention_objects(text[], uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.powerhub_finish_storage_image_retention_objects(text[], uuid, boolean, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.powerhub_claim_storage_image_retention_objects(text[], uuid, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.powerhub_finish_storage_image_retention_objects(text[], uuid, boolean, timestamptz)
  TO service_role;
