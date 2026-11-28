-- Archived privileged behavior only. NEVER a hosted migration.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
 IF current_database() <> 'pr359_real_append' THEN
   RAISE EXCEPTION 'PR359_DISPOSABLE_DATABASE_REQUIRED';
 END IF;
END $guard$;
CREATE TABLE public.generator_maintenance_work_orders (
 id bigint PRIMARY KEY, tenant_id bigint NOT NULL, site_id bigint NOT NULL
);
INSERT INTO public.generator_maintenance_work_orders VALUES (930001,1,101),(930002,1,101);
DO $verify$
DECLARE
 before_cursor bigint;
 cursor_now bigint;
 before_count bigint;
 page jsonb;
 payload jsonb;
BEGIN
 SELECT last_cursor INTO STRICT before_cursor FROM public.powerhub_sync_scope_state
 WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events';
 SELECT count(*) INTO before_count FROM public.powerhub_sync_changes;
 payload := jsonb_build_object('id','930003','tenant_id',2,'site_id',201);
 cursor_now := public.powerhub_append_fuel_maintenance_delta_sync_change(
  1,101,'fuel_events','930003','upsert',payload);
 IF cursor_now IS DISTINCT FROM before_cursor+1 OR NOT EXISTS (
  SELECT 1 FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101
   AND entity_type='fuel_events' AND cursor=cursor_now AND entity_id='930003'
   AND change_type='upsert' AND row_data=payload
 ) THEN RAISE EXCEPTION 'PR359_ARCHIVED_FUEL_PAYLOAD_BEHAVIOR_CHANGED'; END IF;
 page := public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'fuel_events',before_cursor,cursor_now,200);
 IF page->>'status' IS DISTINCT FROM 'ok' OR jsonb_array_length(page->'changes') IS DISTINCT FROM 1
 OR page->'changes'->0->'row_data' IS DISTINCT FROM payload THEN
  RAISE EXCEPTION 'PR359_ARCHIVED_FUEL_PULL_BEHAVIOR_CHANGED';
 END IF;
 payload := jsonb_build_object('id','930004','tenant_id',1,'site_id',101,'work_order_id',930002);
 cursor_now := public.powerhub_append_fuel_maintenance_delta_sync_change(
  1,101,'maintenance_work_order_parts:930001','930004','upsert',payload);
 IF cursor_now IS DISTINCT FROM 1 OR NOT EXISTS (
  SELECT 1 FROM public.powerhub_sync_changes WHERE tenant_id=1 AND site_id=101
   AND entity_type='maintenance_work_order_parts:930001' AND cursor=cursor_now
   AND entity_id='930004' AND change_type='upsert' AND row_data=payload
 ) THEN RAISE EXCEPTION 'PR359_ARCHIVED_PART_PAYLOAD_BEHAVIOR_CHANGED'; END IF;
 page := public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'maintenance_work_order_parts:930001',0,1,200);
 IF page->>'status' IS DISTINCT FROM 'ok' OR jsonb_array_length(page->'changes') IS DISTINCT FROM 1
 OR page->'changes'->0->'row_data' IS DISTINCT FROM payload THEN
  RAISE EXCEPTION 'PR359_ARCHIVED_PART_PULL_BEHAVIOR_CHANGED';
 END IF;
 IF (SELECT count(*) FROM public.powerhub_sync_changes) IS DISTINCT FROM before_count+2
 OR (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=2 AND site_id=201 AND entity_type='fuel_events') IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'PR359_ARCHIVED_PAYLOAD_TEST_UNEXPECTED_SIDE_EFFECT';
 END IF;
END $verify$;
ROLLBACK;
DO $rollback$
BEGIN
 IF EXISTS (SELECT 1 FROM public.powerhub_sync_changes WHERE entity_id IN ('930003','930004'))
 OR EXISTS (SELECT 1 FROM public.powerhub_sync_scope_state WHERE entity_type='maintenance_work_order_parts:930001')
 OR to_regclass('public.generator_maintenance_work_orders') IS NOT NULL
 OR (SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=1 AND site_id=101 AND entity_type='fuel_events') IS DISTINCT FROM 3 THEN
  RAISE EXCEPTION 'PR359_ARCHIVED_PAYLOAD_TEST_ROLLBACK_FAILED';
 END IF;
END $rollback$;
SELECT 'PR359_ARCHIVED_PRIVILEGED_APPEND_PAYLOAD_GAP_REPRODUCED';
SELECT 'PR359_ARCHIVED_PAYLOAD_TEST_ROLLBACK_PASS';
SELECT 'PR359_REAL_PRODUCER_FULL_CALLER_CLOSURE_APPROVED=FALSE';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
