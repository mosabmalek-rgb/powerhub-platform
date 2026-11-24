\set ON_ERROR_STOP on
DO $fail$
DECLARE caught boolean:=false;
BEGIN
 BEGIN
  PERFORM public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,true);
 EXCEPTION WHEN SQLSTATE 'P3592' THEN caught:=true;
 END;
 IF NOT caught OR EXISTS(SELECT 1 FROM public.pr359_synthetic_change_sink)
 OR (SELECT cursor_seq FROM public.pr359_synthetic_change_checkpoint)<>0
 THEN RAISE EXCEPTION 'PR359_CHANGE_PARTIAL_COMMIT_AFTER_INJECTION'; END IF;
END
$fail$;
SELECT 'PR359_ISOLATED_CHANGE_JOURNAL_FAILURE_ROLLBACK_PASS';
