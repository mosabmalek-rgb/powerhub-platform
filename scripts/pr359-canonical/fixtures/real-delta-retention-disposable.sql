-- Disposable PostgreSQL only; this test uses the actual archived append
-- and pull definitions already loaded in pr359_real_append.
\set ON_ERROR_STOP on
INSERT INTO public.sites(id,tenant_id) VALUES(102,1);
INSERT INTO public.powerhub_sync_scope_state
(tenant_id,site_id,entity_type,last_cursor,retained_from_cursor)
VALUES (1,102,'fuel_events',10499,0);
INSERT INTO public.powerhub_sync_changes
(tenant_id,site_id,entity_type,cursor,entity_id,change_type,row_data)
SELECT 1,102,'fuel_events',n,n::text,'upsert',
 jsonb_build_object('id',n::text)
FROM generate_series(1,10499) n;
DO $run$
DECLARE cursor_now bigint;
DECLARE stale jsonb;
DECLARE missing jsonb;
DECLARE page1 jsonb;
DECLARE pageLast jsonb;
DECLARE fresh jsonb;
BEGIN
 cursor_now:=public.powerhub_append_fuel_maintenance_delta_sync_change(
  1,102,'fuel_events','10500','upsert','{"id":"10500"}'::jsonb);
 IF cursor_now<>10500
 OR (SELECT last_cursor FROM public.powerhub_sync_scope_state
     WHERE tenant_id=1 AND site_id=102 AND entity_type='fuel_events')<>10500
 OR (SELECT retained_from_cursor FROM public.powerhub_sync_scope_state
     WHERE tenant_id=1 AND site_id=102 AND entity_type='fuel_events')<>500
 OR (SELECT count(*) FROM public.powerhub_sync_changes
     WHERE tenant_id=1 AND site_id=102 AND entity_type='fuel_events')<>10000
 OR EXISTS (SELECT 1 FROM public.powerhub_sync_changes
     WHERE tenant_id=1 AND site_id=102 AND entity_type='fuel_events' AND cursor<=500)
 THEN RAISE EXCEPTION 'PR359_REAL_APPEND_RETENTION_PRUNE_FAILED'; END IF;

 stale:=public.powerhub_pull_fuel_maintenance_sync_delta(1,102,'fuel_events',499,NULL,200);
 missing:=public.powerhub_pull_fuel_maintenance_sync_delta(1,102,'fuel_events',NULL,NULL,200);
 IF stale->>'status'<>'reset_required'
 OR (stale->>'retained_from_cursor')<>'500'
 OR (stale->>'current_cursor')<>'10500'
 OR (stale->>'snapshot_cursor')<>'10500'
 OR (stale->>'next_cursor') IS NOT NULL
 OR missing->>'status'<>'reset_required'
 OR jsonb_array_length(stale->'changes')<>0
 THEN RAISE EXCEPTION 'PR359_REAL_PULL_STALE_CURSOR_RESET_FAILED'; END IF;

 page1:=public.powerhub_pull_fuel_maintenance_sync_delta(1,102,'fuel_events',500,10500,200);
 IF page1->>'status'<>'ok'
 OR (page1->>'next_cursor')<>'700'
 OR (page1->>'through_cursor')<>'10500'
 OR (page1->>'has_more')<>'true'
 OR jsonb_array_length(page1->'changes')<>200
 OR page1->'changes'->0->>'cursor'<>'501'
 OR page1->'changes'->199->>'cursor'<>'700'
 THEN RAISE EXCEPTION 'PR359_REAL_PULL_RETENTION_PAGE_FAILED'; END IF;

 pageLast:=public.powerhub_pull_fuel_maintenance_sync_delta(1,102,'fuel_events',10499,10500,200);
 IF pageLast->>'status'<>'ok'
 OR (pageLast->>'next_cursor')<>'10500'
 OR (pageLast->>'has_more')<>'false'
 OR jsonb_array_length(pageLast->'changes')<>1
 OR pageLast->'changes'->0->>'cursor'<>'10500'
 THEN RAISE EXCEPTION 'PR359_REAL_PULL_LAST_PAGE_FAILED'; END IF;

 fresh:=public.powerhub_pull_fuel_maintenance_sync_delta(2,201,'fuel_events',0,NULL,200);
 IF fresh->>'status'<>'ok' OR (fresh->>'current_cursor')<>'1'
 THEN RAISE EXCEPTION 'PR359_RETENTION_CROSSTENANT_LEAK'; END IF;
END
$run$;
SELECT 'PR359_REAL_RETENTION_10500_RESET_REQUIRED_PASS';
SELECT 'PR359_REAL_RETENTION_PAGE_200_AND_SCOPE_PASS';
SELECT 'PR359_ANDROID_REBOOTSTRAP_RUNTIME_VERIFIED=FALSE';
SELECT 'PR359_REAL_RETENTION_PRODUCTION_APPROVED=FALSE';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
