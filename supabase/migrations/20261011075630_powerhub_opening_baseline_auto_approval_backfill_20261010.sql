-- Automatically approve opening baselines but do not issue consumption invoices for them.
-- Subscriber-create and bulk-import function bodies are patched in place to preserve deployed logic.

-- Preserve all existing subscriber-import logic and patch only the two opening-reading approval guards.
-- This avoids replacing newer production function bodies with older staging/export copies.
DO $function_patch$
DECLARE
  v_function_oid oid;
  v_definition text;
  v_patched text;
BEGIN
  SELECT p.oid INTO v_function_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'powerhub_create_subscriber_with_opening_reading'
    AND p.pronargs = 15;

  IF v_function_oid IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_CREATE_SUBSCRIBER_WITH_OPENING_READING_NOT_FOUND';
  END IF;

  SELECT pg_get_functiondef(v_function_oid) INTO v_definition;
  IF position('OPENING_READING_OWNER_REQUIRED' IN v_definition) > 0 THEN
    v_patched := regexp_replace(
      v_definition,
      $pattern$if[[:space:]]+p_opening_reading_approved[[:space:]]+and[[:space:]]+not[[:space:]]+v_owner[[:space:]]+then[[:space:]]+raise exception 'OPENING_READING_OWNER_REQUIRED'[[:space:]]+using errcode[[:space:]]*=[[:space:]]*'P0001';[[:space:]]+end if;$pattern$,
      $replacement$-- Opening baselines are approved immediately for authorized subscriber creation.$replacement$,
      'i'
    );
    IF v_patched = v_definition THEN
      RAISE EXCEPTION 'POWERHUB_OPENING_READING_SINGLE_GUARD_PATTERN_NOT_FOUND';
    END IF;
    EXECUTE v_patched;
  END IF;

  SELECT p.oid INTO v_function_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'powerhub_bulk_upsert_subscribers'
    AND p.pronargs = 8;

  IF v_function_oid IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_BULK_UPSERT_SUBSCRIBERS_NOT_FOUND';
  END IF;

  SELECT pg_get_functiondef(v_function_oid) INTO v_definition;
  IF position('v_opening_approved and not v_owner' IN v_definition) > 0 THEN
    v_patched := regexp_replace(
      v_definition,
      $pattern$if[[:space:]]+v_opening_approved[[:space:]]+and[[:space:]]+not[[:space:]]+v_owner[[:space:]]+then[[:space:]]+out_failed:=[^;]+;[[:space:]]+continue;[[:space:]]+end if;$pattern$,
      $replacement$-- Opening baselines are approved immediately for authorized bulk subscriber imports.$replacement$,
      'i'
    );
    IF v_patched = v_definition THEN
      RAISE EXCEPTION 'POWERHUB_OPENING_READING_BULK_GUARD_PATTERN_NOT_FOUND';
    END IF;
    EXECUTE v_patched;
  END IF;
END
$function_patch$;

revoke execute on function public.powerhub_create_subscriber_with_opening_reading(bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_create_subscriber_with_opening_reading(bigint,bigint,bigint,text,text,text,text,text,uuid,integer,numeric,timestamptz,text,text,boolean) to service_role;

revoke execute on function public.powerhub_bulk_upsert_subscribers(bigint,bigint,bigint,jsonb,boolean,integer,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_bulk_upsert_subscribers(bigint,bigint,bigint,jsonb,boolean,integer,text,text) to service_role;

DO $migration$
DECLARE
  v_approved_count integer := 0;
BEGIN
  WITH pending AS MATERIALIZED (
    SELECT
      mr.id, mr.tenant_id, mr.subscriber_id, mr.status, mr.reading_value,
      mr.previous_reading_value, mr.consumption_kwh, mr.version_no,
      mr.is_opening_baseline, mr.entered_by_user_id,
      s.site_id
    FROM public.meter_readings mr
    JOIN public.subscribers s
      ON s.id = mr.subscriber_id
     AND s.tenant_id = mr.tenant_id
    WHERE mr.is_opening_baseline IS TRUE
      AND mr.status = 'pending_review'
    FOR UPDATE OF mr
  ),
  updated AS (
    UPDATE public.meter_readings mr
       SET status = 'approved',
           reviewed_at = COALESCE(mr.reviewed_at, now()),
           version_no = mr.version_no + 1,
           updated_at = now()
      FROM pending p
     WHERE mr.id = p.id
       AND mr.tenant_id = p.tenant_id
       AND mr.status = 'pending_review'
    RETURNING
      mr.id, mr.tenant_id, mr.subscriber_id, mr.status, mr.reading_value,
      mr.previous_reading_value, mr.consumption_kwh, mr.version_no,
      mr.is_opening_baseline, mr.entered_by_user_id, mr.reviewed_at
  ),
  audit_rows AS (
    INSERT INTO public.audit_logs (
      tenant_id, site_id, user_id, actor_platform_role, actor_tenant_role,
      entity_type, entity_id, action, before_data, after_data, metadata
    )
    SELECT
      u.tenant_id, p.site_id, NULL, NULL, NULL,
      'meter_reading', u.id::text, 'automatic_opening_baseline_approval',
      jsonb_build_object(
        'status', p.status,
        'readingValue', p.reading_value,
        'previousReadingValue', p.previous_reading_value,
        'consumptionKwh', p.consumption_kwh,
        'versionNo', p.version_no,
        'isOpeningBaseline', p.is_opening_baseline
      ),
      jsonb_build_object(
        'status', u.status,
        'readingValue', u.reading_value,
        'previousReadingValue', u.previous_reading_value,
        'consumptionKwh', u.consumption_kwh,
        'versionNo', u.version_no,
        'isOpeningBaseline', u.is_opening_baseline,
        'invoiceIssued', false
      ),
      jsonb_build_object(
        'reason', 'opening_baseline_auto_approval_rollout',
        'migration', '20261011075630_powerhub_opening_baseline_auto_approval_backfill_20261010',
        'initiatedByUserId', p.entered_by_user_id,
        'invoiceIssued', false
      )
    FROM updated u
    JOIN pending p ON p.id = u.id
    RETURNING id
  )
  SELECT count(*)::integer INTO v_approved_count FROM audit_rows;

  RAISE NOTICE 'Automatically approved % pending opening-baseline readings; no invoices were issued.', v_approved_count;
END
$migration$;

