\set ON_ERROR_STOP on
-- Side-effecting function must be executed in its own statement. PostgreSQL
-- is not obligated to evaluate Boolean IF operands left-to-right.
DO $first$
DECLARE
 n integer;
 cursor_after bigint;
 sink_after integer;
BEGIN
 n:=public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false);
 SELECT cursor_seq INTO cursor_after
   FROM public.pr359_synthetic_change_checkpoint
  WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events';
 SELECT count(*) INTO sink_after FROM public.pr359_synthetic_change_sink;
 IF n<>2 OR cursor_after<>2 OR sink_after<>1
 OR NOT EXISTS(
   SELECT 1 FROM public.pr359_synthetic_change_sink
   WHERE tenant_id=1 AND site_id=10 AND generator_id=1
     AND kind='fuel_events' AND event_id=201
     AND change_kind='delete' AND revision=2 AND change_seq=2
 ) THEN
 RAISE EXCEPTION 'PR359_CHANGE_FIRST_PAGE_OR_TOMBSTONE_INVALID processed=% cursor=% sink=%',
   n,cursor_after,sink_after;
 END IF;
END
$first$;
SELECT 'PR359_ISOLATED_CHANGE_JOURNAL_FIRST_PAGE_COMMITTED_PASS';
