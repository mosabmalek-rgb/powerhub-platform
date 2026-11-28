-- Candidate definitions were installed inside the same guarded, rolled-back
-- synthetic transaction, after historical source characterization.
-- Include positive cross-tenant and cross-site controls with reused item/warehouse IDs.
INSERT INTO public.generator_maintenance_work_orders(id,tenant_id,site_id,generator_id,reported_at,created_at,title,assigned_supplier_id)
 VALUES(98501,1,102,1001,'2026-01-01','2026-01-01','other site',91),
       (98502,2,201,1001,'2026-01-01','2026-01-01','other tenant',91);
INSERT INTO public.generator_maintenance_work_order_parts(id,tenant_id,site_id,work_order_id,generator_id,item_id,warehouse_id,quantity)
 VALUES(99501,1,102,98501,1001,72,81,1),(99502,2,201,98502,1001,72,81,1);
INSERT INTO public.inventory_items VALUES(74,1,'UNRELATED-PART','spare');
INSERT INTO public.generator_maintenance_work_order_parts(id,tenant_id,site_id,work_order_id,generator_id,item_id,warehouse_id,quantity)
 VALUES(99004,1,101,98002,1001,74,82,1);
TRUNCATE indirect_before;
INSERT INTO indirect_before SELECT * FROM public.powerhub_sync_scope_state;
-- No history cutoff for per-parent parts. Each affected part must emit exactly once.
UPDATE public.inventory_warehouses SET name='WH-A-CANDIDATE' WHERE tenant_id=1 AND site_id=101 AND id=81;
DO $check$
DECLARE page jsonb; snap jsonb; prior bigint;
BEGIN
 IF pg_temp.delta_added(1,101,'fuel_events')<>499
 OR pg_temp.delta_added(1,101,'maintenance_work_order_parts:98002')<>1
 OR pg_temp.delta_added(1,101,'maintenance_work_order_parts:98001')<>1
 OR pg_temp.delta_added(1,102,'maintenance_work_order_parts:98501')<>0
 OR pg_temp.delta_added(2,201,'maintenance_work_order_parts:98502')<>0
 OR pg_temp.delta_added(1,101,'maintenance_work_orders')<>0
 OR NOT EXISTS(SELECT 1 FROM public.powerhub_sync_changes c JOIN indirect_before b USING(tenant_id,site_id,entity_type)
 WHERE c.tenant_id=1 AND c.site_id=101 AND c.entity_type='maintenance_work_order_parts:98002' AND c.cursor>b.last_cursor AND c.entity_id='99002' AND c.row_data->>'warehouse_name'='WH-A-CANDIDATE')
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_WAREHOUSE_TARGETED_PARTS_FAILED'; END IF;
 SELECT last_cursor INTO STRICT prior FROM indirect_before WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:98001';
 page:=public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'maintenance_work_order_parts:98001',prior,null,200);
 snap:=public.powerhub_get_fuel_maintenance_sync_snapshot(1,101,'maintenance_work_order_parts:98001');
 IF page->>'status' IS DISTINCT FROM 'ok'
 OR jsonb_array_length(page->'changes') IS DISTINCT FROM 1
 OR page->'changes'->0->>'entity_id' IS DISTINCT FROM '99001'
 OR page->'changes'->0->'row_data' IS DISTINCT FROM snap->'rows'->0
 OR snap->>'snapshot_cursor' IS DISTINCT FROM (prior+1)::text
 OR page->'changes'->0->'row_data'->>'warehouse_name' IS DISTINCT FROM 'WH-A-CANDIDATE'
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_HISTORICAL_PART_PULL_FAILED'; END IF;
END $check$;
SELECT 'PR359_CANDIDATE_WAREHOUSE_TARGETED_PARTS_PASS';
SELECT 'PR359_CANDIDATE_HISTORICAL_PART_PULL_PASS';
TRUNCATE indirect_before;
INSERT INTO indirect_before SELECT * FROM public.powerhub_sync_scope_state;
UPDATE public.inventory_items SET name='PART-CANDIDATE',category='candidate-category' WHERE tenant_id=1 AND id=72;
DO $check$
DECLARE page jsonb; prior bigint;
BEGIN
 IF pg_temp.delta_added(1,101,'maintenance_work_order_parts:98002')<>2
 OR pg_temp.delta_added(1,101,'maintenance_work_order_parts:98001')<>1
 OR pg_temp.delta_added(1,102,'maintenance_work_order_parts:98501')<>1
 OR pg_temp.delta_added(2,201,'maintenance_work_order_parts:98502')<>0
 OR pg_temp.delta_added(1,101,'fuel_events')<>0
 OR EXISTS(SELECT 1 FROM public.powerhub_sync_changes c JOIN indirect_before b USING(tenant_id,site_id,entity_type)
 WHERE c.tenant_id=1 AND c.entity_type LIKE 'maintenance_work_order_parts:%' AND c.cursor>b.last_cursor
 AND (c.entity_id='99004' OR c.row_data->>'item_name' IS DISTINCT FROM 'PART-CANDIDATE' OR c.row_data->>'category' IS DISTINCT FROM 'candidate-category'))
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_ITEM_TARGETED_PARTS_FAILED'; END IF;
 SELECT last_cursor INTO STRICT prior FROM indirect_before WHERE tenant_id=1 AND site_id=101 AND entity_type='maintenance_work_order_parts:98001';
 page:=public.powerhub_pull_fuel_maintenance_sync_delta(1,101,'maintenance_work_order_parts:98001',prior,null,200);
 IF jsonb_array_length(page->'changes') IS DISTINCT FROM 1
 OR page->'changes'->0->'row_data'->>'item_name' IS DISTINCT FROM 'PART-CANDIDATE'
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_HISTORICAL_ITEM_PULL_FAILED'; END IF;
END $check$;
SELECT 'PR359_CANDIDATE_ITEM_TARGETED_PARTS_PASS';
DO $rollback$
DECLARE states jsonb; journal jsonb; caught boolean:=false;
BEGIN
 SELECT jsonb_agg(to_jsonb(s) ORDER BY tenant_id,site_id,entity_type) INTO states FROM public.powerhub_sync_scope_state s;
 SELECT jsonb_agg(to_jsonb(c) ORDER BY tenant_id,site_id,entity_type,cursor) INTO journal FROM public.powerhub_sync_changes c;
 UPDATE public.inventory_warehouses SET name=name WHERE tenant_id=1 AND site_id=101 AND id=81;
 UPDATE public.inventory_items SET name=name,category=category WHERE tenant_id=1 AND id=72;
 BEGIN
  UPDATE public.inventory_warehouses SET name='ROLLBACK-NAME' WHERE tenant_id=1 AND site_id=101 AND id=81;
  RAISE EXCEPTION USING ERRCODE='P3594',MESSAGE='forced rollback';
 EXCEPTION WHEN SQLSTATE 'P3594' THEN caught:=true;
 END;
 IF NOT caught
 OR (SELECT name FROM public.inventory_warehouses WHERE tenant_id=1 AND site_id=101 AND id=81) IS DISTINCT FROM 'WH-A-CANDIDATE'
 OR states IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(s) ORDER BY tenant_id,site_id,entity_type) FROM public.powerhub_sync_scope_state s)
 OR journal IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(c) ORDER BY tenant_id,site_id,entity_type,cursor) FROM public.powerhub_sync_changes c)
 THEN RAISE EXCEPTION 'PR359_CANDIDATE_INDIRECT_ROLLBACK_FAILED'; END IF;
END $rollback$;
SELECT 'PR359_CANDIDATE_INDIRECT_ROLLBACK_PASS';
