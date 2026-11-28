\set ON_ERROR_STOP on
-- Outer statement catches the intentional exception in a subtransaction.
-- All writes and checkpoint changes from the failed function must roll back.
DO $fail$
DECLARE got_expected boolean := false;
BEGIN
  BEGIN
    PERFORM public.pr359_synthetic_keyset_page(1,10,1,'fuel_events',64,true);
  EXCEPTION WHEN SQLSTATE 'P3591' THEN
    got_expected := true;
  END;
  IF NOT got_expected THEN
    RAISE EXCEPTION 'PR359_SYNTHETIC_EXPECTED_FAILURE_NOT_RAISED';
  END IF;
  IF EXISTS(SELECT 1 FROM public.pr359_synthetic_keyset_sink)
  OR EXISTS(SELECT 1 FROM public.pr359_synthetic_keyset_checkpoint WHERE cursor_id<>0)
  THEN
    RAISE EXCEPTION 'PR359_SYNTHETIC_FAILURE_PARTIAL_COMMIT';
  END IF;
END
$fail$;
SELECT 'PR359_ISOLATED_KEYSET_INJECTED_FAILURE_ROLLBACK_PASS';
