-- For legacy approved readings without invoices, return newly queued invoice SMS ids to the caller.
-- The invoice trigger owns queue creation on this recovery path; the RPC only hands off those rows after commit.
DO $migration$
DECLARE
  v_function_oid oid;
  v_definition text;
  v_patched text;
BEGIN
  SELECT p.oid INTO v_function_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'powerhub_create_reading_and_issue_invoice'
    AND p.pronargs = 16;

  IF v_function_oid IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_CREATE_READING_AND_ISSUE_INVOICE_NOT_FOUND';
  END IF;

  SELECT pg_get_functiondef(v_function_oid) INTO v_definition;

  IF position('array[]::bigint[],coalesce(v_issued.replayed,false);' IN v_definition) > 0 THEN
    v_patched := replace(
      v_definition,
      $old$array[]::bigint[],coalesce(v_issued.replayed,false);$old$,
      $new$coalesce((
        select array_agg(nm.id order by nm.id)
        from public.notification_messages nm
        where nm.tenant_id = p_tenant_id
          and nm.invoice_id = v_issued.invoice_id
          and nm.channel = 'sms'
          and nm.event_type = 'invoice_issued'
          and nm.status = 'pending'
      ), array[]::bigint[]),coalesce(v_issued.replayed,false);$new$
    );

    IF v_patched = v_definition THEN
      RAISE EXCEPTION 'POWERHUB_INVOICE_RECOVERY_NOTIFICATION_PATTERN_NOT_REPLACED';
    END IF;
    EXECUTE v_patched;
  ELSIF position('from public.notification_messages nm' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'POWERHUB_INVOICE_RECOVERY_NOTIFICATION_PATTERN_NOT_FOUND';
  END IF;
END
$migration$;
