-- Test-only scale extension, inside the generator's existing guarded transaction.
-- Existing source characterization and candidate correctness checks run first.
DO $scale_guard$
BEGIN
 IF current_database()<>'pr359_real_capture' THEN
  RAISE EXCEPTION 'PR359_DISPOSABLE_DATABASE_REQUIRED';
 END IF;
END $scale_guard$;
INSERT INTO public.inventory_items VALUES
 (75,1,'SCALE-ITEM','spare'),(77,1,'SCALE-UNRELATED','spare'),(76,2,'SCALE-OTHER-TENANT','spare');
INSERT INTO public.inventory_warehouses VALUES
 (85,1,101,'SCALE-WH'),(86,1,101,'SCALE-WH-UNRELATED'),
 (87,1,102,'SCALE-SITE2'),(88,1,102,'SCALE-SITE2-UNRELATED'),
 (89,2,201,'SCALE-TENANT2'),(90,2,201,'SCALE-TENANT2-UNRELATED');
-- All IDs are globally unique, and parent/generator, item and warehouse links
-- are valid within the synthetic schema's corresponding tenant/site scopes.
CREATE TEMP TABLE scale_parents AS
 SELECT n,200000+n AS order_id,
 CASE WHEN n<=2000 THEN 1 ELSE 2 END::bigint AS tenant_id,
 CASE WHEN n<=1000 THEN 101 WHEN n<=2000 THEN 102 ELSE 201 END::bigint AS site_id
 FROM generate_series(1,3000) n;
INSERT INTO public.generator_maintenance_work_orders(id,tenant_id,site_id,generator_id,reported_at,created_at,title,assigned_supplier_id)
 SELECT order_id,tenant_id,site_id,1001,'2025-01-01'::timestamptz+n*interval '1 minute',
 '2025-01-01','scale historical work',91 FROM scale_parents ORDER BY order_id;
CREATE TEMP TABLE scale_parts AS
 SELECT p.*,400000+n*2+k AS part_id,
 CASE WHEN tenant_id=2 THEN 76 WHEN k=0 AND n%2=0 THEN 75 ELSE 77 END::bigint AS item_id,
 CASE site_id WHEN 101 THEN CASE WHEN k=0 AND n%2=0 THEN 85 ELSE 86 END
 WHEN 102 THEN CASE WHEN k=0 AND n%2=0 THEN 87 ELSE 88 END
 ELSE CASE WHEN k=0 AND n%2=0 THEN 89 ELSE 90 END END::bigint AS warehouse_id
 FROM scale_parents p CROSS JOIN generate_series(0,1) k;
INSERT INTO public.generator_maintenance_work_order_parts(id,tenant_id,site_id,work_order_id,generator_id,item_id,warehouse_id,quantity)
 SELECT part_id,tenant_id,site_id,order_id,1001,item_id,warehouse_id,1
 FROM scale_parts ORDER BY part_id;
-- Reproduce the relevant access paths observed in Staging (not the entire schema).
CREATE INDEX scale_existing_item_idx ON public.generator_maintenance_work_order_parts(tenant_id,item_id);
CREATE INDEX scale_existing_order_idx ON public.generator_maintenance_work_order_parts(tenant_id,site_id,work_order_id,issued_at,id);
CREATE UNIQUE INDEX scale_existing_parent_scope_idx ON public.generator_maintenance_work_orders(tenant_id,site_id,id);
ANALYZE public.generator_maintenance_work_order_parts;
ANALYZE public.generator_maintenance_work_orders;
CREATE TEMP TABLE scale_plans(label text PRIMARY KEY,plan jsonb);
CREATE FUNCTION pg_temp.scale_plan(p_label text,p_query text) RETURNS void LANGUAGE plpgsql AS $plan$
DECLARE plan_json jsonb;
BEGIN
 EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) '||p_query INTO plan_json;
 INSERT INTO scale_plans VALUES(p_label,plan_json);
END $plan$;
-- These SELECTs mirror the exact candidate loops, substituting constants for NEW.
SELECT pg_temp.scale_plan('warehouse_before',$query$
 SELECT p.site_id,p.work_order_id,p.id
 FROM public.generator_maintenance_work_order_parts p
 JOIN public.generator_maintenance_work_orders w
 ON w.tenant_id=p.tenant_id AND w.site_id=p.site_id AND w.id=p.work_order_id
 WHERE p.tenant_id=1 AND p.site_id=101 AND p.warehouse_id=85
 ORDER BY p.site_id,p.work_order_id,p.id
$query$);
SELECT pg_temp.scale_plan('item_existing',$query$
 SELECT p.site_id,p.work_order_id,p.id
 FROM public.generator_maintenance_work_order_parts p
 JOIN public.generator_maintenance_work_orders w
 ON w.tenant_id=p.tenant_id AND w.site_id=p.site_id AND w.id=p.work_order_id
 WHERE p.tenant_id=1 AND p.item_id=75
 ORDER BY p.site_id,p.work_order_id,p.id
$query$);
CREATE INDEX scale_candidate_warehouse_idx ON public.generator_maintenance_work_order_parts(tenant_id,site_id,warehouse_id,work_order_id,id);
ANALYZE public.generator_maintenance_work_order_parts;
SELECT pg_temp.scale_plan('warehouse_after',$query$
 SELECT p.site_id,p.work_order_id,p.id
 FROM public.generator_maintenance_work_order_parts p
 JOIN public.generator_maintenance_work_orders w
 ON w.tenant_id=p.tenant_id AND w.site_id=p.site_id AND w.id=p.work_order_id
 WHERE p.tenant_id=1 AND p.site_id=101 AND p.warehouse_id=85
 ORDER BY p.site_id,p.work_order_id,p.id
$query$);
CREATE INDEX scale_candidate_item_order_idx ON public.generator_maintenance_work_order_parts(tenant_id,item_id,site_id,work_order_id,id);
ANALYZE public.generator_maintenance_work_order_parts;
SELECT pg_temp.scale_plan('item_after',$query$
 SELECT p.site_id,p.work_order_id,p.id
 FROM public.generator_maintenance_work_order_parts p
 JOIN public.generator_maintenance_work_orders w
 ON w.tenant_id=p.tenant_id AND w.site_id=p.site_id AND w.id=p.work_order_id
 WHERE p.tenant_id=1 AND p.item_id=75
 ORDER BY p.site_id,p.work_order_id,p.id
$query$);
DO $plans$
BEGIN
 IF (SELECT count(*) FROM scale_parents)<>3000 OR (SELECT count(*) FROM scale_parts)<>6000
 OR (SELECT count(*) FROM scale_plans)<>4
 OR EXISTS(SELECT 1 FROM scale_plans WHERE (plan->0->'Plan'->>'Actual Rows')::bigint
  IS DISTINCT FROM CASE WHEN label LIKE 'warehouse_%' THEN 500 ELSE 1000 END::bigint)
 THEN RAISE EXCEPTION 'PR359_SCALE_ACCESS_PLAN_ROW_COUNTS_FAILED'; END IF;
END $plans$;
SELECT 'PR359_SCALE_ACCESS_PLAN_COUNTS_PASS';
SELECT 'PR359_SCALE_PLAN='||jsonb_build_object('label',label,'explain',plan)::text FROM scale_plans ORDER BY label;
-- The actual triggers run with archived Capture/Emit/Projectors and candidate Append.
-- Compare complete journal deltas with a formula-derived expected set, including
-- duplicate rows, unrelated scopes, cursor increments and exact projected payloads.
CREATE TEMP TABLE scale_expected(tenant_id bigint,site_id bigint,entity_type text,entity_id text);
CREATE TEMP VIEW scale_new_changes AS
 SELECT c.* FROM public.powerhub_sync_changes c
 LEFT JOIN indirect_before b USING(tenant_id,site_id,entity_type)
 WHERE c.cursor>coalesce(b.last_cursor,0);
CREATE TEMP TABLE scale_metrics(label text PRIMARY KEY,elapsed_ms numeric,expected_events bigint);
CREATE FUNCTION pg_temp.scale_assert(p_field text,p_value text,p_count bigint) RETURNS void LANGUAGE plpgsql AS $check$
BEGIN
 IF (SELECT count(*) FROM scale_expected)<>p_count
 OR EXISTS((SELECT tenant_id,site_id,entity_type,entity_id FROM scale_new_changes
 EXCEPT ALL SELECT tenant_id,site_id,entity_type,entity_id FROM scale_expected)
 UNION ALL (SELECT tenant_id,site_id,entity_type,entity_id FROM scale_expected
 EXCEPT ALL SELECT tenant_id,site_id,entity_type,entity_id FROM scale_new_changes))
 OR EXISTS(SELECT 1 FROM scale_new_changes WHERE change_type IS DISTINCT FROM 'upsert'
 OR row_data->>p_field IS DISTINCT FROM p_value
 OR row_data IS DISTINCT FROM public.powerhub_project_maintenance_work_order_part_delta_row(
 tenant_id,site_id,split_part(entity_type,':',2)::bigint,entity_id::bigint))
 OR EXISTS(SELECT 1 FROM scale_expected e WHERE pg_temp.delta_added(e.tenant_id,e.site_id,e.entity_type)<>1)
 OR (SELECT coalesce(sum(s.last_cursor-coalesce(b.last_cursor,0)),0)
 FROM public.powerhub_sync_scope_state s LEFT JOIN indirect_before b USING(tenant_id,site_id,entity_type))<>p_count
 THEN RAISE EXCEPTION 'PR359_SCALE_EXACT_DELTA_FAILED: %',p_field; END IF;
END $check$;
TRUNCATE indirect_before;
INSERT INTO indirect_before SELECT * FROM public.powerhub_sync_scope_state;
INSERT INTO scale_expected
 SELECT tenant_id,site_id,'maintenance_work_order_parts:'||order_id,part_id::text FROM scale_parts
 WHERE n<=1000 AND n%2=0 AND part_id=400000+n*2;
DO $warehouse$
DECLARE started timestamptz:=clock_timestamp();
BEGIN
 UPDATE public.inventory_warehouses SET name='SCALE-WH-RENAMED' WHERE tenant_id=1 AND site_id=101 AND id=85;
 INSERT INTO scale_metrics VALUES('warehouse',extract(epoch FROM clock_timestamp()-started)*1000,500);
 PERFORM pg_temp.scale_assert('warehouse_name','SCALE-WH-RENAMED',500);
END $warehouse$;
SELECT 'PR359_SCALE_WAREHOUSE_EXACT_DELTA_PASS';
TRUNCATE indirect_before,scale_expected;
INSERT INTO indirect_before SELECT * FROM public.powerhub_sync_scope_state;
INSERT INTO scale_expected
 SELECT tenant_id,site_id,'maintenance_work_order_parts:'||order_id,part_id::text FROM scale_parts
 WHERE n<=2000 AND n%2=0 AND part_id=400000+n*2;
DO $item$
DECLARE started timestamptz:=clock_timestamp(); prior bigint; page jsonb; snap jsonb;
BEGIN
 UPDATE public.inventory_items SET name='SCALE-ITEM-RENAMED',category='scale-renamed' WHERE tenant_id=1 AND id=75;
 INSERT INTO scale_metrics VALUES('item',extract(epoch FROM clock_timestamp()-started)*1000,1000);
 PERFORM pg_temp.scale_assert('item_name','SCALE-ITEM-RENAMED',1000);
 IF EXISTS(SELECT 1 FROM scale_new_changes WHERE row_data->>'category' IS DISTINCT FROM 'scale-renamed') THEN
  RAISE EXCEPTION 'PR359_SCALE_CATEGORY_FAILED';
 END IF;
 SELECT last_cursor INTO STRICT prior FROM indirect_before WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:200002';
 page:=public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'maintenance_work_order_parts:200002',prior,null,200);
 snap:=public.powerhub_get_fuel_maintenance_sync_snapshot(1,101,'maintenance_work_order_parts:200002');
 IF page->>'status' IS DISTINCT FROM 'ok' OR jsonb_array_length(page->'changes') IS DISTINCT FROM 1
 OR page->'changes'->0->>'entity_id' IS DISTINCT FROM '400004'
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snap->'rows') AS x(row)
 WHERE x.row=page->'changes'->0->'row_data')
 OR snap->>'snapshot_cursor' IS DISTINCT FROM (prior+1)::text
 THEN RAISE EXCEPTION 'PR359_SCALE_HISTORICAL_PULL_FAILED'; END IF;
END $item$;
SELECT 'PR359_SCALE_ITEM_EXACT_DELTA_PASS';
SELECT 'PR359_SCALE_METRIC='||to_jsonb(m)::text FROM scale_metrics m ORDER BY label;
-- Outer generator rollback removes all scale records, temporary objects and indexes.
