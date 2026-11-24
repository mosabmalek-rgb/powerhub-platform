\set ON_ERROR_STOP on
-- A new change to a previously seen ID is committed after snapshot capture.
-- It belongs to a subsequent snapshot, never the old upper watermark.
INSERT INTO public.pr359_synthetic_change_journal
 (tenant_id,site_id,generator_id,kind,event_id,change_kind,revision)
 VALUES (1,10,1,'fuel_events',202,'delete',3);
DO $resume$
DECLARE n integer;
DECLARE exhausted integer;
DECLARE cursor_after bigint;
DECLARE sink_after integer;
BEGIN
 n:=public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false);
 exhausted:=public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false);
 SELECT cursor_seq INTO cursor_after FROM public.pr359_synthetic_change_checkpoint
  WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events';
 SELECT count(*) INTO sink_after FROM public.pr359_synthetic_change_sink;
 IF n<>2 OR exhausted<>0 OR cursor_after<>5 OR sink_after<>2
 OR NOT EXISTS(SELECT 1 FROM public.pr359_synthetic_change_sink
               WHERE tenant_id=1 AND site_id=10 AND generator_id=1
                 AND kind='fuel_events' AND event_id=201
                 AND change_kind='delete' AND revision=2 AND change_seq=2)
 OR NOT EXISTS(SELECT 1 FROM public.pr359_synthetic_change_sink
               WHERE tenant_id=1 AND site_id=10 AND generator_id=1
                 AND kind='fuel_events' AND event_id=202
                 AND change_kind='upsert' AND revision=2 AND change_seq=5)
 THEN RAISE EXCEPTION
  'PR359_CHANGE_RESUME_OR_SCOPE_INVALID processed=% exhausted=% cursor=% sink=%',
  n,exhausted,cursor_after,sink_after;
 END IF;
END
$resume$;
SELECT 'PR359_ISOLATED_CHANGE_JOURNAL_CROSS_CONNECTION_RECOVERY_PASS';

-- Explicitly open a new snapshot to incorporate the later delete event.
UPDATE public.pr359_synthetic_change_checkpoint SET snapshot_upper_seq=(
 SELECT max(change_seq) FROM public.pr359_synthetic_change_journal
 WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events'
) WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events';
DO $refresh$
DECLARE n integer;
DECLARE exhausted integer;
DECLARE cursor_after bigint;
DECLARE sink_after integer;
BEGIN
 n:=public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false);
 exhausted:=public.pr359_synthetic_apply_change_page(1,10,1,'fuel_events',2,false);
 SELECT cursor_seq INTO cursor_after FROM public.pr359_synthetic_change_checkpoint
  WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events';
 SELECT count(*) INTO sink_after FROM public.pr359_synthetic_change_sink;
 IF n<>1 OR exhausted<>0 OR cursor_after<>9 OR sink_after<>2
 OR NOT EXISTS(
  SELECT 1 FROM public.pr359_synthetic_change_sink
  WHERE tenant_id=1 AND site_id=10 AND generator_id=1
    AND kind='fuel_events' AND event_id=202
    AND change_kind='delete' AND revision=3 AND change_seq=9)
 OR NOT EXISTS(
  SELECT 1 FROM public.pr359_synthetic_change_sink
  WHERE tenant_id=1 AND site_id=10 AND generator_id=1
    AND kind='fuel_events' AND event_id=201
    AND change_kind='delete' AND revision=2 AND change_seq=2)
 OR EXISTS(
  SELECT 1 FROM public.pr359_synthetic_change_sink
  WHERE tenant_id<>1 OR site_id<>10 OR generator_id<>1 OR kind<>'fuel_events')
 THEN RAISE EXCEPTION
  'PR359_CHANGE_NEW_SNAPSHOT_OR_TOMBSTONE_FAILED processed=% exhausted=% cursor=% sink=%',
  n,exhausted,cursor_after,sink_after;
 END IF;
END
$refresh$;
SELECT 'PR359_ISOLATED_CHANGE_JOURNAL_TOMBSTONE_AND_NEW_SNAPSHOT_PASS';
SELECT 'PR359_REAL_DELTA_PRODUCER_ATOMICITY_PROVEN=FALSE';
SELECT 'PR359_REAL_CHANGE_JOURNAL_CAPTURE_PROVEN=FALSE';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
