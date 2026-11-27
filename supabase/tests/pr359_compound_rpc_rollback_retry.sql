\set ON_ERROR_STOP on
-- Fault-injection on actual repository RPCs loaded in the existing integration DB.
-- No hosted project, no real financial writes, no migration. Not a real deadlock.
BEGIN;
DO $guard$
BEGIN
 IF current_database()<>'maintenance_phase_c_test' THEN
  RAISE EXCEPTION 'PR359_MAINTENANCE_DISPOSABLE_DATABASE_REQUIRED';
 END IF;
END $guard$;
CREATE FUNCTION pg_temp.pr359_retry_part_abort() RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
 IF NEW.entity_type='work_order_part' AND NEW.action='issue'
 AND NEW.operation_key='pr359-rollback-part-001'
 AND current_setting('pr359.retry_fault',true)='part'
 THEN RAISE EXCEPTION USING ERRCODE='40P01',MESSAGE='PR359_INJECTED_PART_ROLLBACK'; END IF;
 RETURN NEW;
END $trigger$;
CREATE TRIGGER pr359_retry_part_abort BEFORE INSERT ON public.generator_maintenance_audit_events
 FOR EACH ROW EXECUTE FUNCTION pg_temp.pr359_retry_part_abort();
CREATE FUNCTION pg_temp.pr359_retry_fuel_abort() RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
 IF NEW.entity_type='generator_fuel_event' AND NEW.action='create'
 AND NEW.metadata->>'operationKey'='pr359-rollback-fuel-001'
 AND current_setting('pr359.retry_fault',true)='fuel'
 THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='PR359_INJECTED_FUEL_ROLLBACK'; END IF;
 RETURN NEW;
END $trigger$;
CREATE TRIGGER pr359_retry_fuel_abort BEFORE INSERT ON public.audit_logs
 FOR EACH ROW EXECUTE FUNCTION pg_temp.pr359_retry_fuel_abort();
-- Compare all rows of these fixture tables, including other tenants and scopes.
-- Sequences are deliberately excluded: PostgreSQL sequence allocation is not transactional.
CREATE FUNCTION pg_temp.pr359_retry_state() RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE tab text; rows_json jsonb; result jsonb:='{}'::jsonb;
BEGIN
 FOREACH tab IN ARRAY ARRAY['inventory_items','inventory_warehouses','inventory_stock_movements','generator_maintenance_work_orders',
 'generator_maintenance_work_order_parts','generator_maintenance_audit_events',
 'generator_fuel_events','generator_fuel_readings','generators','audit_logs',
 'account_transactions','supplier_ledger_entries','powerhub_sync_scope_state','powerhub_sync_changes']
 LOOP
  EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',tab) INTO rows_json;
  result:=result||jsonb_build_object(tab,rows_json);
 END LOOP;
 RETURN result;
END $state$;
DO $retry$
DECLARE
 part_item bigint; fuel_item bigint; tank bigint; wo record; part record; part_replay record;
 fill record; fill_replay record; before_state jsonb; after_state jsonb;
 part_key text:='pr359-rollback-part-001'; fuel_key text:='pr359-rollback-fuel-001';
 fill_at timestamptz:=now(); hours numeric; caught boolean; parts_entity text;
 part_cursor bigint; fuel_cursor bigint; balance_before numeric; balance_after numeric;
BEGIN
 INSERT INTO public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id)
 VALUES(10,'PR359-RETRY-PART','Retry part','spare_part','piece',0,1) RETURNING id INTO part_item;
 INSERT INTO public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id)
 VALUES(10,'PR359-RETRY-FUEL','Retry fuel','fuel','liter',0,1) RETURNING id INTO fuel_item;
 INSERT INTO public.inventory_warehouses(tenant_id,site_id,code,name,location_type,generator_id,created_by_user_id)
 VALUES(10,100,'PR359-RETRY-TANK','Retry tank','generator_fuel_tank',10000,1) RETURNING id INTO tank;
 PERFORM * FROM public.powerhub_inventory_record_stock_movement(10,100,1,1,part_item,
 'adjustment_in',5,12.50,null,'PR359-RETRY-PART','Disposable part seed','pr359-retry-part-seed');
 PERFORM * FROM public.powerhub_inventory_record_stock_movement(10,100,1,1,fuel_item,
 'adjustment_in',5,8.00,null,'PR359-RETRY-FUEL','Disposable fuel seed','pr359-retry-fuel-seed');
 SELECT * INTO STRICT wo FROM public.powerhub_maintenance_create_work_order(
 10,100,1,10000,null,'breakdown','high','PR359 retry test',null,fill_at,null,null,'pr359-retry-order');
 parts_entity:='maintenance_work_order_parts:'||wo.work_order_id::text;
 SELECT coalesce(max(last_cursor),0) INTO part_cursor FROM public.powerhub_sync_scope_state
 WHERE tenant_id=10 AND site_id=100 AND entity_type=parts_entity;

 -- A failure at final audit must undo the nested stock issue, part, order cost
 -- and all Delta changes. The fault is injected, not a genuine lock cycle.
 PERFORM set_config('pr359.retry_fault','part',true);
 before_state:=pg_temp.pr359_retry_state();
 caught:=false;
 BEGIN
  PERFORM * FROM public.powerhub_maintenance_add_part(10,100,1,wo.work_order_id,part_item,1,2,'Retry test',part_key);
 EXCEPTION WHEN SQLSTATE '40P01' THEN
  IF SQLERRM<>'PR359_INJECTED_PART_ROLLBACK' THEN RAISE; END IF;
  caught:=true;
 END;
 IF NOT caught OR before_state IS DISTINCT FROM pg_temp.pr359_retry_state()
 THEN RAISE EXCEPTION 'PR359_REAL_PART_RPC_ROLLBACK_MISMATCH'; END IF;
 PERFORM set_config('pr359.retry_fault','off',true);
 SELECT * INTO STRICT part FROM public.powerhub_maintenance_add_part(10,100,1,wo.work_order_id,part_item,1,2,'Retry test',part_key);
 IF part.replayed IS DISTINCT FROM false OR part.quantity IS DISTINCT FROM 2::numeric OR part.total_cost_amount IS DISTINCT FROM 25::numeric
 OR (SELECT count(*) FROM public.inventory_stock_movements WHERE tenant_id=10 AND site_id=100 AND operation_key='maint-part:10:'||md5(part_key))<>1
 OR (SELECT count(*) FROM public.generator_maintenance_work_order_parts WHERE tenant_id=10 AND site_id=100 AND operation_key=part_key)<>1
 OR (SELECT count(*) FROM public.generator_maintenance_audit_events WHERE tenant_id=10 AND site_id=100 AND operation_key=part_key AND action='issue')<>1
 OR (SELECT parts_cost FROM public.generator_maintenance_work_orders WHERE id=wo.work_order_id) IS DISTINCT FROM 25::numeric
 OR (SELECT count(*) FROM public.powerhub_sync_changes WHERE tenant_id=10 AND site_id=100 AND entity_type=parts_entity AND cursor>part_cursor AND entity_id=part.part_id::text AND change_type='upsert'
 AND row_data=public.powerhub_project_maintenance_work_order_part_delta_row(10,100,wo.work_order_id,part.part_id))<>1
 OR (SELECT count(*) FROM public.powerhub_sync_changes WHERE tenant_id=10 AND site_id=100 AND entity_type=parts_entity AND cursor>part_cursor AND entity_id=part.part_id::text)<>1
 THEN RAISE EXCEPTION 'PR359_REAL_PART_RPC_RETRY_EFFECT_MISMATCH'; END IF;
 SELECT coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then quantity else -quantity end),0)
 INTO balance_after FROM public.inventory_stock_movements WHERE tenant_id=10 AND site_id=100 AND warehouse_id=1 AND item_id=part_item;
 IF balance_after<>3 THEN RAISE EXCEPTION 'PR359_REAL_PART_RPC_STOCK_MISMATCH'; END IF;
 after_state:=pg_temp.pr359_retry_state();
 SELECT * INTO STRICT part_replay FROM public.powerhub_maintenance_add_part(10,100,1,wo.work_order_id,part_item,1,2,'Retry test',part_key);
 IF part_replay.replayed IS DISTINCT FROM true OR part_replay.part_id IS DISTINCT FROM part.part_id
 OR part_replay.stock_movement_id IS DISTINCT FROM part.stock_movement_id OR after_state IS DISTINCT FROM pg_temp.pr359_retry_state()
 THEN RAISE EXCEPTION 'PR359_REAL_PART_RPC_REPLAY_MISMATCH'; END IF;
 -- A replay with a changed valid payload must fail closed, without any side effect.
 caught:=false;
 BEGIN
  PERFORM * FROM public.powerhub_maintenance_add_part(10,100,1,wo.work_order_id,part_item,1,2,'Changed retry payload',part_key);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'MAINTENANCE_IDEMPOTENCY_KEY_REUSED' THEN RAISE; END IF;
  caught:=true;
 END;
 IF NOT caught OR after_state IS DISTINCT FROM pg_temp.pr359_retry_state()
 THEN RAISE EXCEPTION 'PR359_REAL_PART_RPC_CONFLICT_STATE_MISMATCH'; END IF;

 -- Fuel fill uses the loaded 20261104215427 issue-based implementation and
 -- optional level/hour readings. Fail its final audit after the nested work.
 SELECT greatest(coalesce(g.operating_hours,0),10) INTO STRICT hours FROM public.generators g
 WHERE g.tenant_id=10 AND g.site_id=100 AND g.id=10000;
 SELECT coalesce(max(last_cursor),0) INTO fuel_cursor FROM public.powerhub_sync_scope_state
 WHERE tenant_id=10 AND site_id=100 AND entity_type='fuel_events';
 PERFORM set_config('pr359.retry_fault','fuel',true);
 before_state:=pg_temp.pr359_retry_state();
 caught:=false;
 BEGIN
  PERFORM * FROM public.powerhub_inventory_record_fuel_fill(10,100,1,10000,fuel_item,1,tank,1,fill_at,0,1,hours,'PR359-RETRY-FILL','Retry test',fuel_key);
 EXCEPTION WHEN SQLSTATE '40001' THEN
  IF SQLERRM<>'PR359_INJECTED_FUEL_ROLLBACK' THEN RAISE; END IF;
  caught:=true;
 END;
 IF NOT caught OR before_state IS DISTINCT FROM pg_temp.pr359_retry_state()
 THEN RAISE EXCEPTION 'PR359_REAL_FUEL_RPC_ROLLBACK_MISMATCH'; END IF;
 PERFORM set_config('pr359.retry_fault','off',true);
 SELECT * INTO STRICT fill FROM public.powerhub_inventory_record_fuel_fill(10,100,1,10000,fuel_item,1,tank,1,fill_at,0,1,hours,'PR359-RETRY-FILL','Retry test',fuel_key);
 IF fill.replayed IS DISTINCT FROM false OR fill.litres IS DISTINCT FROM 1::numeric OR fill.total_cost_amount IS DISTINCT FROM 8::numeric
 OR (SELECT count(*) FROM public.inventory_stock_movements WHERE tenant_id=10 AND site_id=100 AND operation_key='fuel-fill:'||fuel_key||':issue')<>1
 OR (SELECT count(*) FROM public.generator_fuel_events WHERE tenant_id=10 AND site_id=100 AND operation_key=fuel_key)<>1
 OR (SELECT count(*) FROM public.generator_fuel_readings WHERE tenant_id=10 AND site_id=100 AND operation_key IN (fuel_key||':level-before',fuel_key||':level-after',fuel_key||':operating-hours'))<>3
 OR (SELECT count(*) FROM public.audit_logs WHERE tenant_id=10 AND site_id=100 AND entity_type='generator_fuel_event' AND action='create' AND metadata->>'operationKey'=fuel_key)<>1
 OR (SELECT count(*) FROM public.powerhub_sync_changes WHERE tenant_id=10 AND site_id=100 AND entity_type='fuel_events' AND cursor>fuel_cursor AND entity_id=fill.fuel_event_id::text AND change_type='upsert'
 AND row_data=public.powerhub_project_fuel_event_delta_row(10,100,fill.fuel_event_id))<>1
 OR (SELECT count(*) FROM public.powerhub_sync_changes WHERE tenant_id=10 AND site_id=100 AND entity_type='fuel_events' AND cursor>fuel_cursor AND entity_id=fill.fuel_event_id::text)<>1
 THEN RAISE EXCEPTION 'PR359_REAL_FUEL_RPC_RETRY_EFFECT_MISMATCH'; END IF;
 SELECT coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then quantity else -quantity end),0)
 INTO balance_after FROM public.inventory_stock_movements WHERE tenant_id=10 AND site_id=100 AND warehouse_id=1 AND item_id=fuel_item;
 IF balance_after<>4 THEN RAISE EXCEPTION 'PR359_REAL_FUEL_RPC_STOCK_MISMATCH'; END IF;
 after_state:=pg_temp.pr359_retry_state();
 SELECT * INTO STRICT fill_replay FROM public.powerhub_inventory_record_fuel_fill(10,100,1,10000,fuel_item,1,tank,1,fill_at,0,1,hours,'PR359-RETRY-FILL','Retry test',fuel_key);
 IF fill_replay.replayed IS DISTINCT FROM true OR fill_replay.fuel_event_id IS DISTINCT FROM fill.fuel_event_id
 OR after_state IS DISTINCT FROM pg_temp.pr359_retry_state()
 THEN RAISE EXCEPTION 'PR359_REAL_FUEL_RPC_REPLAY_MISMATCH'; END IF;
 caught:=false;
 BEGIN
  PERFORM * FROM public.powerhub_inventory_record_fuel_fill(10,100,1,10000,fuel_item,1,tank,1,fill_at,0,1,hours,'PR359-RETRY-FILL','Changed retry payload',fuel_key);
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'IDEMPOTENCY_KEY_REUSED' THEN RAISE; END IF;
  caught:=true;
 END;
 IF NOT caught OR after_state IS DISTINCT FROM pg_temp.pr359_retry_state()
 THEN RAISE EXCEPTION 'PR359_REAL_FUEL_RPC_CONFLICT_STATE_MISMATCH'; END IF;
END $retry$;
ROLLBACK;
DO $restore$
BEGIN
 IF EXISTS(SELECT 1 FROM public.inventory_items WHERE tenant_id=10 AND sku IN ('PR359-RETRY-PART','PR359-RETRY-FUEL'))
 OR EXISTS(SELECT 1 FROM public.inventory_warehouses WHERE tenant_id=10 AND code='PR359-RETRY-TANK')
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN ('pr359_retry_part_abort','pr359_retry_fuel_abort'))
 THEN RAISE EXCEPTION 'PR359_REAL_RPC_RETRY_FIXTURE_RESTORE_FAILED'; END IF;
END $restore$;
SELECT 'PR359_REAL_PART_RPC_INJECTED_ROLLBACK_RETRY_REPLAY_PASS';
SELECT 'PR359_REAL_FUEL_RPC_INJECTED_ROLLBACK_RETRY_REPLAY_PASS';
SELECT 'PR359_REAL_RPC_RETRY_FIXTURE_RESTORE_PASS';
SELECT 'PR359_REAL_RPC_CONFLICT_NO_SIDE_EFFECTS_PASS';
SELECT 'PR359_REAL_RPC_EXACT_TARGET_JOURNAL_PASS';
SELECT 'PR359_REAL_RPC_DEADLOCK_FULL_RUNTIME_APPROVED=FALSE';
