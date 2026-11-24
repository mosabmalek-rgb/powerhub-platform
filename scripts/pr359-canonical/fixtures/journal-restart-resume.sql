\set ON_ERROR_STOP on
-- A new update to an already-seen event ID is inserted AFTER snapshot capture.
-- It must not enter the earlier snapshot, but must be picked up by a new run.
INSERT INTO public.pr359_synthetic_change_journal
 (tenant_id,site_id,generator_id,kind,event_id,change_kind,revision)
 VALUES (1,10,1,'fuel_events',202,'delete',3);
DO $resume$
DECLARE n integer;
BEGIN
 n:=public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false);
 IF n<>2 THEN RAISE EXCEPTION 'PR359_CHANGE_RESUME_PAGE_COUNT_%',n; END IF;
 IF public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false)<>0
 THEN RAISE EXCEPTION 'PR359_CHANGE_SNAPSHOT_UPPER_NOT_RESPECTED'; END IF;
 IF (SELECT cursor_seq FROM public.pr359_synthetic_change_checkpoint)<>5
 OR (SELECT count(*) FROM public.pr359_synthetic_change_sink)<>2
 OR NOT EXISTS(SELECT 1 FROM public.pr359_synthetic_change_sink
               WHERE tenant_id=1 AND site_id=10 AND generator_id=1
                 AND kind='fuel_events' AND event_id=201
                 AND change_kind='delete' AND revision=2 AND change_seq=2)
 OR NOT EXISTS(SELECT 1 FROM public.pr359_synthetic_change_sink
               WHERE tenant_id=1 AND site_id=10 AND generator_id=1
                 AND kind='fuel_events' AND event_id=202
                 AND change_kind='upsert' AND revision=2 AND change_seq=5)
 THEN RAISE EXCEPTION 'PR359_CHANGE_RESUME_OR_SCOPE_INVALID'; END IF;
END
$resume$;
SELECT 'PR359_ISOLATED_CHANGE_JOURNAL_CROSS_CONNECTION_RECOVERY_PASS';

-- A new snapshot explicitly advances the upper bound. Its event_seq is 9.
UPDATE public.pr359_synthetic_change_checkpoint SET snapshot_upper_seq=(
 SELECT max(change_seq) FROM public.pr359_synthetic_change_journal
 WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events'
) WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events';
DO $refresh$
DECLARE n integer;
BEGIN
 n:=public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false);
 IF n<>1 OR public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false)<>0
 OR (SELECT cursor_seq FROM public.pr359_synthetic_change_checkpoint)<>9
 OR (SELECT count(*) FROM public.pr359_synthetic_change_sink)<>2
 OR NOT EXISTS(
  SELECT 1 FROM public.pr359_synthetic_change_sink
  WHERE event_id=202 AND change_kind='delete' AND revision=3 AND change_seq=9)
 OR NOT EXISTS(
  SELECT 1 FROM public.pr359_synthetic_change_sink
  WHERE event_id=201 AND change_kind='delete' AND revision=2 AND change_seq=2)
 OR EXISTS(
  SELECT 1 FROM public.pr359_synthetic_change_sink
  WHERE tenant_id<>1 OR site_id<>10 OR generator_id<>1 OR kind<>'fuel_events')
 THEN RAISE EXCEPTION 'PR359_CHANGE_NEW_SNAPSHOT_OR_TOMBSTONE_FAILED'; END IF;
END
$refresh$;
SELECT 'PR359_ISOLATED_CHANGE_JOURNAL_TOMBSTONE_AND_NEW_SNAPSHOT_PASS';
SELECT 'PR359_REAL_DELTA_PRODUCER_ATOMICITY_PROVEN=FALSE';
SELECT 'PR359_REAL_CHANGE_JOURNAL_CAPTURE_PROVEN=FALSE';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
