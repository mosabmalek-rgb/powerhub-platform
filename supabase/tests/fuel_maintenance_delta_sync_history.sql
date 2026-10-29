\set ON_ERROR_STOP on

-- Runs after inventory_maintenance_phase_c.sql has created the disposable inventory
-- and maintenance fixture and applied the Delta migrations listed at that file's end.
do $fuel_maintenance_delta$
declare
  v_tank_id bigint;
  v_fuel_event_id bigint;
  v_fuel_item_id bigint;
  v_item_id bigint;
  v_order record;
  v_part record;
  v_assign record;
  v_snapshot jsonb;
  v_delta jsonb;
  v_parts_entity text;
  v_snapshot_cursor bigint;
  v_first_plan_id bigint;
  v_replacement_plan_id bigint;
  v_first_reading_id bigint;
  v_replacement_reading_id bigint;
  v_visible_count integer;
begin
  insert into public.inventory_warehouses(
    tenant_id,site_id,code,name,location_type,generator_id,created_by_user_id
  ) values (10,100,'DELTA-TANK','Delta fuel tank','generator_fuel_tank',10000,1)
  returning id into v_tank_id;

  insert into public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id)
  values (10,'DELTA-FUEL-ITEM','Delta fuel item','fuel','liter',0,1)
  returning id into v_fuel_item_id;
  perform * from public.powerhub_inventory_record_stock_movement(
    10,100,1,1,v_fuel_item_id,'adjustment_in',5,8.00,null,
    'DELTA-FUEL-STOCK','Delta fuel fixture','delta-fuel-stock-001'
  );

  select fuel_event_id into v_fuel_event_id
  from public.powerhub_inventory_record_fuel_fill(
    10,100,1,10000,v_fuel_item_id,1,v_tank_id,1.000,now(),0,1,10,
    'DELTA-FUEL-REF','Do not persist this note','delta-fuel-event-001'
  );
  if v_fuel_event_id is null then raise exception 'DELTA_FUEL_EVENT_NOT_CREATED'; end if;

  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'fuel_events') into v_snapshot;
  if v_snapshot->>'status'<>'ok' or not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r
    where r->>'id'=v_fuel_event_id::text and r->>'generator_id'='10000'
      and r->'notes'='null'::jsonb and not (r ? 'unit_cost') and not (r ? 'total_cost_amount')
  ) then raise exception 'DELTA_FUEL_EVENT_SNAPSHOT_PROJECTION_FAILED'; end if;

  select public.powerhub_pull_fuel_maintenance_sync_delta(10,100,'fuel_events',0,null,200) into v_delta;
  if v_delta->>'status'<>'ok' or not exists (
    select 1 from jsonb_array_elements(v_delta->'changes') c
    where c->>'entity_id'=v_fuel_event_id::text and c->>'operation'='upsert'
  ) then raise exception 'DELTA_FUEL_EVENT_JOURNAL_FAILED'; end if;

  insert into public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id)
  values (10,'DELTA-MAINT-PART','Delta maintenance part','spare_part','piece',0,1)
  returning id into v_item_id;
  perform * from public.powerhub_inventory_record_stock_movement(
    10,100,1,1,v_item_id,'adjustment_in',5,12.50,null,
    'DELTA-MAINT-STOCK','Delta maintenance part fixture','delta-maint-stock-001'
  );

  select * into v_order from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,null,'breakdown','high','Delta test repair','Delta test description',
    now(),null,null,'delta-maint-order-001'
  );
  if v_order.work_order_id is null then raise exception 'DELTA_MAINTENANCE_ORDER_NOT_CREATED'; end if;

  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'maintenance_work_orders') into v_snapshot;
  if not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r
    where r->>'id'=v_order.work_order_id::text and r->>'work_order_number' is not null
      and r->>'status'='new' and r->'created_by_user_id'='null'::jsonb
  ) then raise exception 'DELTA_MAINTENANCE_ORDER_SNAPSHOT_FAILED'; end if;
  v_snapshot_cursor:=coalesce((v_snapshot->>'snapshot_cursor')::bigint,0);

  select * into v_assign from public.powerhub_maintenance_assign_supplier(
    10,100,1,v_order.work_order_id,1,'delta-maint-assign-supplier-001'
  );
  select public.powerhub_pull_fuel_maintenance_sync_delta(
    10,100,'maintenance_work_orders',v_snapshot_cursor,null,200
  ) into v_delta;
  if not exists (
    select 1 from jsonb_array_elements(v_delta->'changes') c
    where c->>'entity_id'=v_order.work_order_id::text and c->>'operation'='upsert'
      and c->'row_data'->>'assigned_supplier_id'='1'
  ) then raise exception 'DELTA_MAINTENANCE_ORDER_UPDATE_MISSING'; end if;

  select * into v_part from public.powerhub_maintenance_add_part(
    10,100,1,v_order.work_order_id,v_item_id,1,1,'Do not persist this note','delta-maint-part-001'
  );
  if v_part.part_id is null then raise exception 'DELTA_MAINTENANCE_PART_NOT_CREATED'; end if;
  v_parts_entity:='maintenance_work_order_parts:'||v_order.work_order_id::text;
  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,v_parts_entity) into v_snapshot;
  if not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r
    where r->>'id'=v_part.part_id::text and r->>'work_order_id'=v_order.work_order_id::text
      and r->'notes'='null'::jsonb
  ) then raise exception 'DELTA_MAINTENANCE_PART_SNAPSHOT_FAILED'; end if;

  begin
    perform public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'maintenance_work_order_parts:999999999');
    raise exception 'DELTA_CROSS_ORDER_PART_SNAPSHOT_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'POWERHUB_SYNC_WORK_ORDER_OUT_OF_SCOPE' then raise; end if;
  end;

  -- Seed more than the top-500 boundary without producing one journal refresh per fixture row.
  alter table public.generator_fuel_readings disable trigger powerhub_delta_operational_readings;
  insert into public.generator_fuel_readings(
    tenant_id,site_id,generator_id,reading_type,tank_warehouse_id,reading_value,recorded_at,
    reference_no,notes,corrects_reading_id,correction_reason,operation_key,operation_payload_hash,created_by_user_id
  )
  select 10,100,10000,'operating_hours',null,g::numeric,
    timestamptz '2090-01-01 00:00:00+00' + (g-1)*interval '1 day',
    null,null,null,null,'delta-bounded-reading-'||lpad(g::text,3,'0'),
    'delta-bounded-reading-payload-'||g,1
  from generate_series(1,501) g;
  alter table public.generator_fuel_readings enable trigger powerhub_delta_operational_readings;
  perform public.powerhub_refresh_fuel_reading_delta_scope(10,100);
  select id into v_first_reading_id from public.generator_fuel_readings
    where operation_key='delta-bounded-reading-501';
  select id into v_replacement_reading_id from public.generator_fuel_readings
    where operation_key='delta-bounded-reading-001';
  delete from public.generator_fuel_readings where id=v_first_reading_id;
  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'fuel_readings') into v_snapshot;
  v_visible_count:=jsonb_array_length(v_snapshot->'rows');
  if v_visible_count<>500 or exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_first_reading_id::text
  ) or not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_reading_id::text
  ) then raise exception 'DELTA_FUEL_READING_DELETE_DID_NOT_REFILL_TOP_500'; end if;

  alter table public.generator_maintenance_preventive_plans disable trigger powerhub_delta_operational_maintenance_plans;
  insert into public.generator_maintenance_preventive_plans(
    tenant_id,site_id,generator_id,plan_code,title,interval_days,next_due_at,
    operation_key,operation_payload_hash,created_by_user_id
  )
  select 10,100,10000,'DELTA-BOUND-PLAN-'||lpad(g::text,3,'0'),
    'Bounded maintenance plan '||g,30,
    timestamptz '2000-01-01 00:00:00+00' + (g-1)*interval '1 day',
    'delta-bounded-plan-'||g,'delta-bounded-plan-payload-'||g,1
  from generate_series(1,501) g;
  alter table public.generator_maintenance_preventive_plans enable trigger powerhub_delta_operational_maintenance_plans;
  perform public.powerhub_refresh_maintenance_plan_delta_scope(10,100);
  select id into v_first_plan_id from public.generator_maintenance_preventive_plans
    where plan_code='DELTA-BOUND-PLAN-001';
  select id into v_replacement_plan_id from public.generator_maintenance_preventive_plans
    where plan_code='DELTA-BOUND-PLAN-501';
  delete from public.generator_maintenance_preventive_plans where id=v_first_plan_id;
  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'maintenance_preventive_plans') into v_snapshot;
  v_visible_count:=jsonb_array_length(v_snapshot->'rows');
  if v_visible_count<>500 or exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_first_plan_id::text
  ) or not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_plan_id::text
  ) then raise exception 'DELTA_MAINTENANCE_PLAN_DELETE_DID_NOT_REFILL_TOP_500'; end if;
end;
$fuel_maintenance_delta$;

select 'Fuel-event and maintenance work-order/parts Delta snapshot, update, redaction and scope assertions passed' as result;
