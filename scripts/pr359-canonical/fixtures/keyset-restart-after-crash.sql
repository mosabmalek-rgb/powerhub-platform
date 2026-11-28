\set ON_ERROR_STOP on
-- Separate psql connection emulates a restarted worker after first commit.
DO $resume$
DECLARE
 n integer;
 total integer;
BEGIN
 -- Retrying first-page-sized work from persisted cursor must not duplicate.
 n:=public.pr359_synthetic_keyset_page(1,10,1,'fuel_events',64,false);
 IF n<>64 THEN RAISE EXCEPTION 'PR359_KEYSET_SECOND_PAGE_COUNT_%',n; END IF;
 n:=public.pr359_synthetic_keyset_page(1,10,1,'fuel_events',64,false);
 IF n<>2 THEN RAISE EXCEPTION 'PR359_KEYSET_THIRD_PAGE_COUNT_%',n; END IF;
 n:=public.pr359_synthetic_keyset_page(1,10,1,'fuel_events',64,false);
 IF n<>0 THEN RAISE EXCEPTION 'PR359_KEYSET_EXHAUSTED_PAGE_COUNT_%',n; END IF;
 n:=public.pr359_synthetic_keyset_page(1,10,1,'maintenance_work_orders',64,false);
 IF n<>64 THEN RAISE EXCEPTION 'PR359_KEYSET_MAINTENANCE_PAGE_ONE_%',n; END IF;
 n:=public.pr359_synthetic_keyset_page(1,10,1,'maintenance_work_orders',64,false);
 IF n<>6 THEN RAISE EXCEPTION 'PR359_KEYSET_MAINTENANCE_PAGE_TWO_%',n; END IF;
 n:=public.pr359_synthetic_keyset_page(1,10,1,'maintenance_work_orders',64,false);
 IF n<>0 THEN RAISE EXCEPTION 'PR359_KEYSET_MAINTENANCE_EXHAUSTED_%',n; END IF;
 SELECT count(*) INTO total FROM public.pr359_synthetic_keyset_sink;
 IF total<>200 THEN RAISE EXCEPTION 'PR359_KEYSET_TOTAL_%',total; END IF;
 IF (SELECT cursor_id FROM public.pr359_synthetic_keyset_checkpoint
     WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='fuel_events')<>130
 OR (SELECT cursor_id FROM public.pr359_synthetic_keyset_checkpoint
     WHERE tenant_id=1 AND site_id=10 AND generator_id=1 AND kind='maintenance_work_orders')<>70
 OR EXISTS (SELECT 1 FROM public.pr359_synthetic_keyset_sink
   WHERE tenant_id<>1 OR site_id<>10 OR generator_id<>1)
 THEN RAISE EXCEPTION 'PR359_KEYSET_CURSOR_OR_SCOPE_FAILED'; END IF;
END
$resume$;
SELECT 'PR359_ISOLATED_KEYSET_CROSS_CONNECTION_RECOVERY_PASS';

-- A later row beyond the captured high-water mark is NOT silently
-- included in the prior snapshot.
INSERT INTO public.pr359_synthetic_keyset_source VALUES (1,10,1,'fuel_events',131);
DO $upper$
BEGIN
 IF public.pr359_synthetic_keyset_page(1,10,1,'fuel_events',64,false)<>0
 OR EXISTS (SELECT 1 FROM public.pr359_synthetic_keyset_sink
            WHERE kind='fuel_events' AND event_id=131)
 THEN RAISE EXCEPTION 'PR359_KEYSET_SNAPSHOT_BOUNDARY_VIOLATED'; END IF;
END
$upper$;
SELECT 'PR359_ISOLATED_KEYSET_HIGH_WATER_MARK_PASS';
SELECT 'PR359_REAL_DELTA_OUTBOX_ATOMICITY_PROVEN=FALSE';
SELECT 'PR359_CROSS_DEVICE_IDEMPOTENCY_PROVEN=FALSE';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
