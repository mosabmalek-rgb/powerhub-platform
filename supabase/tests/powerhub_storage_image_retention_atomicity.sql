\set ON_ERROR_STOP on

BEGIN;

DO $roles$
BEGIN
  BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.payment_documentation_requests (
  id bigint PRIMARY KEY,
  receipt_image_key text,
  receipt_image_deleted_at timestamptz,
  receipt_image_retention_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.payments (
  id bigint PRIMARY KEY,
  receipt_image_key text
);
CREATE TABLE public.meter_readings (
  id bigint PRIMARY KEY,
  image_key text
);
CREATE TABLE public.chat_message_attachments (
  id bigint PRIMARY KEY,
  storage_bucket text NOT NULL,
  storage_path text NOT NULL,
  storage_deleted_at timestamptz
);

\ir ../migrations/20261102133000_powerhub_storage_image_retention_atomic_claims.sql

DO $acl$
DECLARE
  v_claim oid := 'public.powerhub_claim_storage_image_retention_objects(text[],uuid,timestamptz)'::regprocedure;
  v_finish oid := 'public.powerhub_finish_storage_image_retention_objects(text[],uuid,boolean,timestamptz)'::regprocedure;
BEGIN
  IF has_function_privilege('anon', v_claim, 'EXECUTE')
     OR has_function_privilege('authenticated', v_claim, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_claim, 'EXECUTE')
     OR has_function_privilege('anon', v_finish, 'EXECUTE')
     OR has_function_privilege('authenticated', v_finish, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_finish, 'EXECUTE') THEN
    RAISE EXCEPTION 'STORAGE_IMAGE_RETENTION_RPC_ACL_MISMATCH';
  END IF;

  IF has_table_privilege('anon', 'private.powerhub_storage_image_retention_claims', 'SELECT')
     OR has_table_privilege('authenticated', 'private.powerhub_storage_image_retention_claims', 'SELECT')
     OR has_table_privilege('service_role', 'private.powerhub_storage_image_retention_claims', 'SELECT') THEN
    RAISE EXCEPTION 'STORAGE_IMAGE_RETENTION_CLAIMS_TABLE_EXPOSED';
  END IF;

  IF NOT (
    SELECT relation_row.relrowsecurity AND relation_row.relforcerowsecurity
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid = 'private.powerhub_storage_image_retention_claims'::regclass
  ) THEN
    RAISE EXCEPTION 'STORAGE_IMAGE_RETENTION_CLAIMS_RLS_NOT_FORCED';
  END IF;
END
$acl$;

INSERT INTO public.payment_documentation_requests (id, receipt_image_key)
VALUES (1, 'payment-receipts/t/r.jpg');
INSERT INTO public.payments (id, receipt_image_key)
VALUES (1, 'payment-receipts/t/r.jpg');
INSERT INTO public.meter_readings (id, image_key)
VALUES (1, 'subscriber-readings/t/r.webp');
INSERT INTO public.chat_message_attachments (id, storage_bucket, storage_path)
VALUES (1, 'powerhub-private', 'chat/t/c/m/a.png');

CREATE FUNCTION public.fail_retention_reading_update()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger$
BEGIN
  IF OLD.image_key = 'subscriber-readings/t/r.webp' THEN
    RAISE EXCEPTION 'SIMULATED_REFERENCE_CLEANUP_FAILURE';
  END IF;
  RETURN NEW;
END
$trigger$;

CREATE TRIGGER fail_retention_reading
BEFORE UPDATE ON public.meter_readings
FOR EACH ROW EXECUTE FUNCTION public.fail_retention_reading_update();

-- Invoke the RPC as service_role, exactly as the server does. The trigger
-- forces the third table update to fail; the RPC's transaction must roll back.
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

DO $atomic_failure$
BEGIN
  BEGIN
    PERFORM public.powerhub_claim_storage_image_retention_objects(
      ARRAY[
        'payment-receipts/t/r.jpg',
        'subscriber-readings/t/r.webp',
        'chat/t/c/m/a.png'
      ],
      '00000000-0000-0000-0000-000000000001',
      pg_catalog.clock_timestamp()
    );
    RAISE EXCEPTION 'EXPECTED_REFERENCE_CLEANUP_FAILURE_NOT_RAISED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SIMULATED_REFERENCE_CLEANUP_FAILURE' THEN
      RAISE;
    END IF;
  END;
END
$atomic_failure$;

-- Return to the test owner before inspecting the private claims table.
-- service_role intentionally has no direct schema/table read access.
RESET ROLE;

DO $atomicity_assertions$
BEGIN
  IF (SELECT receipt_image_key FROM public.payment_documentation_requests WHERE id = 1)
       IS DISTINCT FROM 'payment-receipts/t/r.jpg'
     OR (SELECT receipt_image_key FROM public.payments WHERE id = 1)
       IS DISTINCT FROM 'payment-receipts/t/r.jpg'
     OR (SELECT image_key FROM public.meter_readings WHERE id = 1)
       IS DISTINCT FROM 'subscriber-readings/t/r.webp'
     OR (SELECT storage_deleted_at FROM public.chat_message_attachments WHERE id = 1) IS NOT NULL
     OR EXISTS (SELECT 1 FROM private.powerhub_storage_image_retention_claims) THEN
    RAISE EXCEPTION 'STORAGE_IMAGE_REFERENCE_ATOMICITY_BROKEN';
  END IF;
END
$atomicity_assertions$;

DROP TRIGGER fail_retention_reading ON public.meter_readings;
DROP FUNCTION public.fail_retention_reading_update();

-- Retry the same objects as service_role. The first claim detaches all four
-- reference types, an active lease excludes a second worker, a failed Storage
-- removal releases the lease, and a later run may claim the same paths again.
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

DO $retry$
DECLARE
  v_keys text[] := ARRAY[
    'payment-receipts/t/r.jpg',
    'subscriber-readings/t/r.webp',
    'chat/t/c/m/a.png'
  ];
  v_first jsonb;
  v_concurrent jsonb;
  v_released jsonb;
  v_retry jsonb;
  v_finished jsonb;
  v_after_finish jsonb;
BEGIN
  v_first := public.powerhub_claim_storage_image_retention_objects(
    v_keys, '00000000-0000-0000-0000-000000000001', pg_catalog.clock_timestamp()
  );

  IF pg_catalog.jsonb_array_length(v_first->'claimedKeys') <> 3
     OR v_first#>>'{referencesDetached,paymentDocumentationRequests}' <> '1'
     OR v_first#>>'{referencesDetached,payments}' <> '1'
     OR v_first#>>'{referencesDetached,meterReadings}' <> '1'
     OR v_first#>>'{referencesDetached,chatAttachments}' <> '1' THEN
    RAISE EXCEPTION 'STORAGE_IMAGE_REFERENCE_CLAIM_MISMATCH: %', v_first;
  END IF;

  v_concurrent := public.powerhub_claim_storage_image_retention_objects(
    v_keys, '00000000-0000-0000-0000-000000000002', pg_catalog.clock_timestamp()
  );
  IF pg_catalog.jsonb_array_length(v_concurrent->'claimedKeys') <> 0 THEN
    RAISE EXCEPTION 'ACTIVE_STORAGE_IMAGE_CLAIM_NOT_EXCLUSIVE';
  END IF;

  v_released := public.powerhub_finish_storage_image_retention_objects(
    v_keys, '00000000-0000-0000-0000-000000000001', false, pg_catalog.clock_timestamp()
  );
  IF (v_released->>'releasedCount')::bigint <> 3 THEN
    RAISE EXCEPTION 'STORAGE_IMAGE_CLAIM_RELEASE_FAILED';
  END IF;

  v_retry := public.powerhub_claim_storage_image_retention_objects(
    v_keys, '00000000-0000-0000-0000-000000000002', pg_catalog.clock_timestamp()
  );
  IF pg_catalog.jsonb_array_length(v_retry->'claimedKeys') <> 3
     OR v_retry#>>'{referencesDetached,paymentDocumentationRequests}' <> '0'
     OR v_retry#>>'{referencesDetached,payments}' <> '0'
     OR v_retry#>>'{referencesDetached,meterReadings}' <> '0'
     OR v_retry#>>'{referencesDetached,chatAttachments}' <> '0' THEN
    RAISE EXCEPTION 'STORAGE_IMAGE_REFERENCE_RETRY_NOT_IDEMPOTENT: %', v_retry;
  END IF;

  v_finished := public.powerhub_finish_storage_image_retention_objects(
    v_keys, '00000000-0000-0000-0000-000000000002', true, pg_catalog.clock_timestamp()
  );
  IF (v_finished->>'finishedCount')::bigint <> 3 THEN
    RAISE EXCEPTION 'STORAGE_IMAGE_CLAIM_FINALIZATION_FAILED';
  END IF;

  v_after_finish := public.powerhub_claim_storage_image_retention_objects(
    v_keys, '00000000-0000-0000-0000-000000000003', pg_catalog.clock_timestamp()
  );
  IF pg_catalog.jsonb_array_length(v_after_finish->'claimedKeys') <> 0 THEN
    RAISE EXCEPTION 'COMPLETED_STORAGE_IMAGE_CLAIM_WAS_REOPENED';
  END IF;
END
$retry$;

DO $invalid_keys$
BEGIN
  BEGIN
    PERFORM public.powerhub_claim_storage_image_retention_objects(
      ARRAY['payment-receipts/../logos/a.png'],
      '00000000-0000-0000-0000-000000000004',
      pg_catalog.clock_timestamp()
    );
    RAISE EXCEPTION 'STORAGE_IMAGE_PATH_TRAVERSAL_WAS_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'INVALID_STORAGE_IMAGE_RETENTION_KEY' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.powerhub_claim_storage_image_retention_objects(
      ARRAY['payment-receipts/t/a.pdf'],
      '00000000-0000-0000-0000-000000000005',
      pg_catalog.clock_timestamp()
    );
    RAISE EXCEPTION 'NON_IMAGE_STORAGE_OBJECT_WAS_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'INVALID_STORAGE_IMAGE_RETENTION_KEY' THEN RAISE; END IF;
  END;
END
$invalid_keys$;

RESET ROLE;
ROLLBACK;

SELECT 'POWERHUB_STORAGE_IMAGE_RETENTION_ATOMICITY_ASSERTIONS_PASSED' AS result;
