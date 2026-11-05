-- Invoice-period locking must follow the accounting timestamp of issuance.
-- invoices.issue_date defaults to now(); p_due_date is the subscriber's contractual
-- due date and must not move a newly-issued invoice into a different closed period.
--
-- Patch the existing policy-aware issuer and the mobile approval wrapper without
-- rewriting their evolving invoice/notification logic.
DO $migration$
DECLARE
  v_function regprocedure;
  v_definition text;
  v_patched text;
  v_legacy_guard_count integer;
  v_functions regprocedure[] := ARRAY[
    to_regprocedure('public.powerhub_issue_invoice_from_reading(bigint,bigint,bigint,bigint,bigint,text,timestamptz,numeric,uuid)'),
    to_regprocedure('public.powerhub_approve_and_issue_mobile_reading(bigint,bigint,bigint,bigint,integer,timestamptz,text,numeric)')
  ]::regprocedure[];
BEGIN
  IF v_functions[1] IS NULL THEN
    RAISE EXCEPTION 'INVOICE_ISSUER_FUNCTION_NOT_FOUND';
  END IF;

  FOREACH v_function IN ARRAY v_functions LOOP
    IF v_function IS NULL THEN
      CONTINUE;
    END IF;

    v_definition := pg_get_functiondef(v_function);
    v_legacy_guard_count := regexp_count(
      v_definition,
      'period_start[[:space:]]*<=[[:space:]]*p_due_date[[:space:]]+and[[:space:]]+period_end[[:space:]]*>=[[:space:]]*p_due_date',
      'i'
    );

    IF v_legacy_guard_count = 0 THEN
      -- Make migration replay safe, but fail closed on an unexpected future body.
      IF v_definition ~* 'period_start[[:space:]]*<=[[:space:]]*now\(\)[[:space:]]+and[[:space:]]+period_end[[:space:]]*>=[[:space:]]*now\(\)' THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'INVOICE_PERIOD_LOCK_GUARD_ANCHOR_NOT_FOUND: %',v_function;
    END IF;

    IF v_legacy_guard_count <> 1 THEN
      RAISE EXCEPTION 'INVOICE_PERIOD_LOCK_GUARD_AMBIGUOUS: % (% matches)',v_function,v_legacy_guard_count;
    END IF;

    v_patched := regexp_replace(
      v_definition,
      'period_start[[:space:]]*<=[[:space:]]*p_due_date[[:space:]]+and[[:space:]]+period_end[[:space:]]*>=[[:space:]]*p_due_date',
      'period_start <= now() and period_end >= now()',
      'i'
    );

    IF v_patched = v_definition
       OR v_patched ~* 'period_start[[:space:]]*<=[[:space:]]*p_due_date[[:space:]]+and[[:space:]]+period_end[[:space:]]*>=[[:space:]]*p_due_date' THEN
      RAISE EXCEPTION 'INVOICE_PERIOD_LOCK_GUARD_PATCH_FAILED: %',v_function;
    END IF;

    EXECUTE v_patched;
  END LOOP;
END
$migration$;

NOTIFY pgrst, 'reload schema';
