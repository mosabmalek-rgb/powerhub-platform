\set ON_ERROR_STOP on
DO $first$
BEGIN
 IF public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false)<>2
 OR (SELECT cursor_seq FROM public.pr359_synthetic_change_checkpoint)<>2
 OR (SELECT count(*) FROM public.pr359_synthetic_change_sink)<>1
 OR NOT EXISTS(
   SELECT 1 FROM public.pr359_synthetic_change_sink
   WHERE event_id=201 AND change_kind='delete' AND revision=2
     AND change_seq=2
 ) THEN
 RAISE EXCEPTION 'PR359_CHANGE_FIRST_PAGE_OR_TOMBSTONE_INVALID';
 END IF;
END
$first$;
SELECT 'PR359_ISOLATED_CHANGE_JOURNAL_FIRST_PAGE_COMMITTED_PASS';
