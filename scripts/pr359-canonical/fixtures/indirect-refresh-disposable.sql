-- Executes only after guarded, transaction-scoped synthetic setup.
-- The indirect refresh, Snapshot and Pull definitions are pinned migration source.
-- Archived projectors, Capture, Emit and candidate Append are loaded by the generator.
INSERT INTO public.generators VALUES(1002,1,101,'UNRELATED');
INSERT INTO public.inventory_items VALUES(73,1,'OTHER-FUEL','fuel');
INSERT INTO public.inventory_warehouses VALUES(83,1,101,'OTHER-WH'),(84,1,101,'OTHER-WH2');
INSERT INTO public.suppliers VALUES(92,1,'OTHER-SUP','X');
INSERT INTO public.generator_fuel_events(id,tenant_id,site_id,generator_id,occurred_at,fuel_item_id,source_warehouse_id,destination_warehouse_id,litres)
 SELECT 97000+n,1,101,CASE WHEN n=501 THEN 1002 ELSE 1001 END,
 '2026-01-01'::timestamptz+n*interval '1 minute',
 CASE WHEN n=501 THEN 73 ELSE 71 END,CASE WHEN n=501 THEN 83 ELSE 81 END,
 CASE WHEN n=501 THEN 84 ELSE 82 END,10
 FROM generate_series(1,501) n;
INSERT INTO public.generator_maintenance_work_orders(id,tenant_id,site_id,generator_id,reported_at,created_at,title,assigned_supplier_id)
 SELECT 98000+n,1,101,CASE WHEN n=201 THEN 1002 ELSE 1001 END,
 '2026-01-01'::timestamptz+n*interval '1 minute','2026-01-01','work',
 CASE WHEN n=201 THEN 92 ELSE 91 END FROM generate_series(1,201) n;
INSERT INTO public.generator_maintenance_work_order_parts(id,tenant_id,site_id,work_order_id,generator_id,item_id,warehouse_id,quantity)
 VALUES(99001,1,101,98001,1001,72,81,1),(99002,1,101,98002,1001,72,81,1),
 (99003,1,101,98002,1001,72,82,1);
INSERT INTO public.generator_fuel_events(id,tenant_id,site_id,generator_id,occurred_at,fuel_item_id,source_warehouse_id,destination_warehouse_id,litres)
 VALUES(97001+1000,2,201,1001,'2026-01-01',71,81,82,10),(97002+1000,1,102,1001,'2026-01-01',71,81,82,10);
CREATE TEMP TABLE indirect_before AS SELECT * FROM public.powerhub_sync_scope_state;
CREATE TEMP TABLE historical_before AS SELECT public.powerhub_get_fuel_maintenance_sync_snapshot(1,101,'maintenance_work_order_parts:98001') AS snap;
CREATE FUNCTION pg_temp.delta_added(t bigint,s bigint,e text) RETURNS bigint LANGUAGE sql AS $f$
 SELECT coalesce((SELECT last_cursor FROM public.powerhub_sync_scope_state WHERE tenant_id=t AND site_id=s AND entity_type=e),0)
 -coalesce((SELECT last_cursor FROM indirect_before WHERE tenant_id=t AND site_id=s AND entity_type=e),0)
$f$;
UPDATE public.generators SET name='GEN-A-RENAMED' WHERE tenant_id=1 AND site_id=101 AND id=1001;
DO $check$
DECLARE f jsonb; w jsonb;
BEGIN
 f:=public.powerhub_get_fuel_maintenance_sync_snapshot(1,101,'fuel_events');
 w:=public.powerhub_get_fuel_maintenance_sync_snapshot(1,101,'maintenance_work_orders');
 IF jsonb_array_length(f->'rows') IS DISTINCT FROM 500
 OR jsonb_array_length(w->'rows') IS DISTINCT FROM 200
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(f->'rows') r WHERE r->>'id'='97001')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(w->'rows') r WHERE r->>'id'='98001')
 OR (SELECT count(*) FROM jsonb_array_elements(f->'rows') r WHERE r->>'generator_name'='GEN-A-RENAMED')<>499
 OR (SELECT count(*) FROM jsonb_array_elements(w->'rows') r WHERE r->>'generator_name'='GEN-A-RENAMED')<>199
 OR pg_temp.delta_added(1,101,'fuel_events')<>499
 OR pg_temp.delta_added(1,101,'maintenance_work_orders')<>199
 OR pg_temp.delta_added(2,201,'fuel_events')<>0
 OR pg_temp.delta_added(1,102,'fuel_events')<>0
 THEN RAISE EXCEPTION 'PR359_SOURCE_RENAME_BOUNDED_SNAPSHOT_FAILED'; END IF;
END $check$;
SELECT 'PR359_SOURCE_RENAME_BOUNDED_SNAPSHOT_PASS';
TRUNCATE indirect_before;
INSERT INTO indirect_before SELECT * FROM public.powerhub_sync_scope_state;
UPDATE public.inventory_warehouses SET name='WH-A-RENAMED' WHERE tenant_id=1 AND site_id=101 AND id=81;
DO $check$
DECLARE historical jsonb; page jsonb; prior bigint;
BEGIN
 -- Two source triggers each refresh both parts of the visible parent, including the unaffected warehouse.
 IF pg_temp.delta_added(1,101,'fuel_events')<>499
 OR pg_temp.delta_added(1,101,'maintenance_work_order_parts:98002')<>4
 OR pg_temp.delta_added(1,101,'maintenance_work_order_parts:98001')<>0
 OR (SELECT count(*) FROM public.powerhub_sync_changes c JOIN indirect_before b USING(tenant_id,site_id,entity_type)
 WHERE c.tenant_id=1 AND c.site_id=101 AND c.entity_type='maintenance_work_order_parts:98002' AND c.cursor>b.last_cursor AND c.entity_id='99002' AND c.row_data->>'warehouse_name'='WH-A-RENAMED')<>2
 OR (SELECT count(*) FROM public.powerhub_sync_changes c JOIN indirect_before b USING(tenant_id,site_id,entity_type)
 WHERE c.tenant_id=1 AND c.site_id=101 AND c.entity_type='maintenance_work_order_parts:98002' AND c.cursor>b.last_cursor AND c.entity_id='99003' AND c.row_data->>'warehouse_name'='WH-B')<>2
 THEN RAISE EXCEPTION 'PR359_SOURCE_WAREHOUSE_DUPLICATION_CHANGED'; END IF;
 historical:=public.powerhub_get_fuel_maintenance_sync_snapshot(1,101,'maintenance_work_order_parts:98001');
 SELECT (snap->>'snapshot_cursor')::bigint INTO prior FROM historical_before;
 page:=public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'maintenance_work_order_parts:98001',prior,null,200);
 IF (SELECT snap->'rows'->0->>'warehouse_name' FROM historical_before) IS DISTINCT FROM 'WH-A'
 OR historical->'rows'->0->>'warehouse_name' IS DISTINCT FROM 'WH-A-RENAMED'
 OR historical->>'snapshot_cursor' IS DISTINCT FROM prior::text
 OR page->>'status' IS DISTINCT FROM 'ok'
 OR page->'changes' IS DISTINCT FROM '[]'::jsonb
 THEN RAISE EXCEPTION 'PR359_SOURCE_HISTORICAL_PART_STALENESS_CHANGED'; END IF;
END $check$;
SELECT 'PR359_SOURCE_WAREHOUSE_DUPLICATION_CHARACTERIZED';
SELECT 'PR359_SOURCE_HISTORICAL_PART_STALENESS_CHARACTERIZED';
SELECT 'PR359_SOURCE_INDIRECT_COUNTS='||jsonb_build_object('fuel_rename',pg_temp.delta_added(1,101,'fuel_events'),'visible_part_events',pg_temp.delta_added(1,101,'maintenance_work_order_parts:98002'),'historical_part_events',pg_temp.delta_added(1,101,'maintenance_work_order_parts:98001'))::text;
TRUNCATE indirect_before;
INSERT INTO indirect_before SELECT * FROM public.powerhub_sync_scope_state;
UPDATE public.inventory_items SET name='PART-A-RENAMED',category='new-category' WHERE tenant_id=1 AND id=72;
UPDATE public.inventory_items SET name='FUEL-A-RENAMED' WHERE tenant_id=1 AND id=71;
UPDATE public.suppliers SET name='SUP-A-RENAMED',supplier_code='A2' WHERE tenant_id=1 AND id=91;
DO $check$
DECLARE historical jsonb;
BEGIN
 historical:=public.powerhub_get_fuel_maintenance_sync_snapshot(1,101,'maintenance_work_order_parts:98001');
 IF pg_temp.delta_added(1,101,'maintenance_work_order_parts:98002')<>2
 OR pg_temp.delta_added(1,101,'maintenance_work_order_parts:98001')<>0
 OR historical->'rows'->0->>'item_name' IS DISTINCT FROM 'PART-A-RENAMED'
 OR historical->'rows'->0->>'category' IS DISTINCT FROM 'new-category'
 OR pg_temp.delta_added(1,101,'fuel_events')<>499
 OR pg_temp.delta_added(1,102,'fuel_events')<>1
 OR pg_temp.delta_added(2,201,'fuel_events')<>0
 OR pg_temp.delta_added(1,101,'maintenance_work_orders')<>199
 OR public.powerhub_project_maintenance_work_order_delta_row(1,101,98002)->>'assigned_supplier_code' IS DISTINCT FROM 'A2'
 THEN RAISE EXCEPTION 'PR359_SOURCE_ITEM_SUPPLIER_REFRESH_FAILED'; END IF;
END $check$;
SELECT 'PR359_SOURCE_ITEM_SUPPLIER_REFRESH_PASS';
TRUNCATE indirect_before;
INSERT INTO indirect_before SELECT * FROM public.powerhub_sync_scope_state;
UPDATE public.generators SET name=name WHERE tenant_id=1 AND site_id=101 AND id=1001;
UPDATE public.inventory_warehouses SET name=name WHERE tenant_id=1 AND site_id=101 AND id=81;
UPDATE public.inventory_items SET name=name,category=category WHERE tenant_id=1 AND id=72;
UPDATE public.suppliers SET name=name,supplier_code=supplier_code WHERE tenant_id=1 AND id=91;
DO $check$
BEGIN
 IF EXISTS((SELECT * FROM public.powerhub_sync_scope_state EXCEPT SELECT * FROM indirect_before)
 UNION ALL (SELECT * FROM indirect_before EXCEPT SELECT * FROM public.powerhub_sync_scope_state))
 OR public.powerhub_project_fuel_event_delta_row(2,201,98001)->>'generator_name' IS DISTINCT FROM 'GEN-OTHER'
 THEN RAISE EXCEPTION 'PR359_SOURCE_INDIRECT_NOOP_OR_SCOPE_FAILED'; END IF;
END $check$;
SELECT 'PR359_SOURCE_INDIRECT_NOOP_AND_ISOLATION_PASS';
ROLLBACK;
DO $restore$
BEGIN
 IF to_regclass('public.generators') IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.powerhub_sync_changes WHERE entity_id IN ('97001','98001','99001','99002','99003'))
 OR to_regprocedure('public.powerhub_get_fuel_maintenance_sync_snapshot(bigint,bigint,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'PR359_SOURCE_INDIRECT_FIXTURE_RESTORE_FAILED'; END IF;
END $restore$;
SELECT 'PR359_SOURCE_INDIRECT_FIXTURE_RESTORE_PASS';
SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';
