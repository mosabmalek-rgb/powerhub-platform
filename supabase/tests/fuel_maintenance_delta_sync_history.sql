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
  v_updated_plan_id bigint;
  v_first_reading_id bigint;
  v_replacement_reading_id bigint;
  v_visible_count integer;
  v_operating_hours numeric;
begin
  insert into public.inventory_warehouses(
    tenant_id,site_id,code,name,location_type,generator_id,created_by_user_id
  ) values (10,100,'DELTA-TANK','Delta fuel tank','generator_fuel_tank',10000,1)
  returning id into v_tank_id;

  insert into public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id)
  values (10,'DELTA-FUEL-ITEM','Delta fuel item','fuel','liter',0,1)
  returning id into v_fuel_item_id;
  select coalesce(g.operating_hours,0) into v_operating_hours
  from public.generators g where g.tenant_id=10 and g.site_id=100 and g.id=10000;
  perform * from public.powerhub_inventory_record_stock_movement(
    10,100,1,1,v_fuel_item_id,'adjustment_in',5,8.00,null,
    'DELTA-FUEL-STOCK','Delta fuel fixture','delta-fuel-stock-001'
  );

  select fuel_event_id into v_fuel_event_id
  from public.powerhub_inventory_record_fuel_fill(
    10,100,1,10000,v_fuel_item_id,1,v_tank_id,1.000,now(),0,1,greatest(v_operating_hours,10),
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
  select public.powerhub_get_operational_sync_snapshot(10,100,'fuel_readings') into v_snapshot;
  v_visible_count:=jsonb_array_length(v_snapshot->'rows');
  if v_visible_count<>500 or exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_first_reading_id::text
  ) or not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_reading_id::text
  ) then raise exception 'DELTA_FUEL_READING_DELETE_DID_NOT_REFILL_TOP_500'; end if;

  alter table public.generator_maintenance_preventive_plans disable trigger powerhub_delta_operational_maintenance_plans;
  alter table public.generator_maintenance_alert_events disable trigger powerhub_delta_operational_maintenance_plans_after_alert_change;
  insert into public.generator_maintenance_preventive_plans(
    tenant_id,site_id,generator_id,plan_code,title,interval_days,next_due_at,
    operation_key,operation_payload_hash,created_by_user_id
  )
  select 10,100,10000,'DELTA-BOUND-PLAN-'||lpad(g::text,3,'0'),
    'Bounded maintenance plan '||g,30,
    timestamptz '2000-01-01 00:00:00+00' + (g-1)*interval '1 day',
    'delta-bounded-plan-'||g,'delta-bounded-plan-payload-'||g,1
  from generate_series(1,501) g;
  insert into public.generator_maintenance_alert_events(
    tenant_id,site_id,generator_id,plan_id,alert_type,alert_key,due_at
  )
  select p.tenant_id,p.site_id,p.generator_id,p.id,'overdue',
    'delta-bounded-alert-'||p.plan_code,p.next_due_at
  from public.generator_maintenance_preventive_plans p
  where p.tenant_id=10 and p.site_id=100 and p.plan_code like 'DELTA-BOUND-PLAN-%';
  alter table public.generator_maintenance_alert_events enable trigger powerhub_delta_operational_maintenance_plans_after_alert_change;
  alter table public.generator_maintenance_preventive_plans enable trigger powerhub_delta_operational_maintenance_plans;
  perform public.powerhub_refresh_maintenance_plan_delta_scope(10,100);
  select id into v_first_plan_id from public.generator_maintenance_preventive_plans
    where plan_code='DELTA-BOUND-PLAN-001';
  select id into v_replacement_plan_id from public.generator_maintenance_preventive_plans
    where plan_code='DELTA-BOUND-PLAN-501';
  alter table public.generator_maintenance_alert_events disable trigger powerhub_delta_operational_maintenance_plans_after_alert_change;
  delete from public.generator_maintenance_alert_events where plan_id=v_first_plan_id;
  alter table public.generator_maintenance_alert_events enable trigger powerhub_delta_operational_maintenance_plans_after_alert_change;
  delete from public.generator_maintenance_preventive_plans where id=v_first_plan_id;
  select public.powerhub_get_operational_sync_snapshot(10,100,'maintenance_preventive_plans') into v_snapshot;
  v_visible_count:=jsonb_array_length(v_snapshot->'rows');
  if v_visible_count<>500 or exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_first_plan_id::text
  ) or not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_plan_id::text
  ) then raise exception 'DELTA_MAINTENANCE_PLAN_DELETE_DID_NOT_REFILL_TOP_500'; end if;

  -- Move a plan to a distant due date and resolve its overdue alert. Together
  -- these changes move it outside the current priority window and must restore #501.
  select id into v_updated_plan_id from public.generator_maintenance_preventive_plans
    where plan_code='DELTA-BOUND-PLAN-002';
  update public.generator_maintenance_preventive_plans
    set next_due_at=timestamptz '2099-01-01 00:00:00+00',updated_at=clock_timestamp()
    where id=v_updated_plan_id;
  update public.generator_maintenance_alert_events
    set alert_type='resolved',resolved_at=clock_timestamp(),updated_at=clock_timestamp()
    where plan_id=v_updated_plan_id and alert_type='overdue';
  select public.powerhub_get_operational_sync_snapshot(10,100,'maintenance_preventive_plans') into v_snapshot;
  v_visible_count:=jsonb_array_length(v_snapshot->'rows');
  if v_visible_count<>500 or exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_updated_plan_id::text
  ) or not exists (
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_plan_id::text
  ) then raise exception 'DELTA_MAINTENANCE_PLAN_UPDATE_LEFT_STALE_TOP_500_MEMBERSHIP'; end if;
end;
$fuel_maintenance_delta$;

-- Regression: deleting the newest row in the bounded top-200 work-order feed
-- must emit the newly visible #201 row, not leave the offline list one row short.
do $bounded_work_order_membership$
declare
  v_deleted_id bigint;
  v_replacement_id bigint;
  v_snapshot jsonb;
  v_delta jsonb;
  v_cursor bigint;
  v_count integer;
begin
  insert into public.generator_maintenance_work_orders(
    tenant_id,site_id,generator_id,work_order_number,order_type,priority,status,title,
    reported_at,operation_key,operation_payload_hash,created_by_user_id
  )
  select 10,100,10000,'DELTA-BOUND-WO-'||lpad(g::text,3,'0'),
    'breakdown','normal','new','Bounded work order '||g,
    timestamptz '2090-01-01 00:00:00+00'+g*interval '1 day',
    'delta-bounded-work-order-'||lpad(g::text,3,'0'),'delta-bounded-work-order-payload-'||g,1
  from generate_series(1,201) g;

  select id into v_deleted_id from public.generator_maintenance_work_orders
    where tenant_id=10 and site_id=100 and operation_key='delta-bounded-work-order-201';
  select id into v_replacement_id from public.generator_maintenance_work_orders
    where tenant_id=10 and site_id=100 and operation_key='delta-bounded-work-order-001';

  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'maintenance_work_orders')
    into v_snapshot;
  v_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;
  v_count:=jsonb_array_length(v_snapshot->'rows');
  if v_count<>200 or not exists(
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_deleted_id::text
  ) or exists(
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_id::text
  ) then raise exception 'DELTA_WORK_ORDER_TOP_200_FIXTURE_INVALID'; end if;

  -- Moving the newest row outside the top-200 by correcting reported_at
  -- must remove it and emit the row that crosses from position 201 to 200.
  update public.generator_maintenance_work_orders
    set reported_at=timestamptz '2000-01-01 00:00:00+00'
    where id=v_deleted_id;
  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'maintenance_work_orders')
    into v_snapshot;
  if jsonb_array_length(v_snapshot->'rows')<>200 or exists(
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_deleted_id::text
  ) or not exists(
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_id::text
  ) then raise exception 'DELTA_WORK_ORDER_REORDER_DID_NOT_REFILL_TOP_200'; end if;

  select public.powerhub_pull_fuel_maintenance_sync_delta(
    10,100,'maintenance_work_orders',v_cursor,null,500
  ) into v_delta;
  if not exists(
    select 1 from jsonb_array_elements(v_delta->'changes') c
    where c->>'entity_id'=v_deleted_id::text and c->>'operation'='upsert'
  ) or not exists(
    select 1 from jsonb_array_elements(v_delta->'changes') c
    where c->>'entity_id'=v_replacement_id::text and c->>'operation'='upsert'
  ) then raise exception 'DELTA_WORK_ORDER_REORDER_JOURNAL_DID_NOT_REFILL_TOP_200'; end if;

  -- Restore the newest position, checkpoint it, then exercise the delete case separately.
  update public.generator_maintenance_work_orders
    set reported_at=timestamptz '2090-01-01 00:00:00+00'+201*interval '1 day'
    where id=v_deleted_id;
  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'maintenance_work_orders')
    into v_snapshot;
  if not exists(
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_deleted_id::text
  ) or exists(
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_id::text
  ) then raise exception 'DELTA_WORK_ORDER_REORDER_RESTORE_FAILED'; end if;
  v_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;

  delete from public.generator_maintenance_work_orders where id=v_deleted_id;
  if exists(select 1 from public.generator_maintenance_work_orders where id=v_deleted_id) then
    raise exception 'DELTA_WORK_ORDER_FIXTURE_DELETE_DID_NOT_REMOVE_ROW';
  end if;

  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'maintenance_work_orders')
    into v_snapshot;
  v_count:=jsonb_array_length(v_snapshot->'rows');
  if v_count<>200 or exists(
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_deleted_id::text
  ) or not exists(
    select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_id::text
  ) then
    raise exception 'DELTA_WORK_ORDER_DELETE_DID_NOT_REFILL_TOP_200 count=% deleted_present=% replacement_present=% deleted_id=% replacement_id=%',
      v_count,
      exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_deleted_id::text),
      exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_id::text),
      v_deleted_id,v_replacement_id;
  end if;

  select public.powerhub_pull_fuel_maintenance_sync_delta(
    10,100,'maintenance_work_orders',v_cursor,null,500
  ) into v_delta;
  if not exists(
    select 1 from jsonb_array_elements(v_delta->'changes') c
    where c->>'entity_id'=v_deleted_id::text and c->>'operation'='delete'
  ) or not exists(
    select 1 from jsonb_array_elements(v_delta->'changes') c
    where c->>'entity_id'=v_replacement_id::text and c->>'operation'='upsert'
  ) then raise exception 'DELTA_WORK_ORDER_DELETE_JOURNAL_DID_NOT_REFILL_TOP_200'; end if;
end;
$bounded_work_order_membership$;

-- Regression: the bounded top-500 fuel-event feed must refill after an event
-- is moved out of range or deleted; tombstones alone do not reveal row #501.
do $bounded_fuel_event_membership$
declare
  v_i integer;
  v_tank_id bigint;
  v_fuel_item_id bigint;
  v_inserted_id bigint;
  v_moved_id bigint;
  v_replacement_id bigint;
  v_snapshot jsonb;
  v_delta jsonb;
  v_cursor bigint;
  v_change_set jsonb;
  v_count integer;
begin
  select w.id into v_tank_id
  from public.inventory_warehouses w
  where w.tenant_id=10 and w.site_id=100 and w.code='DELTA-TANK';
  select i.id into v_fuel_item_id
  from public.inventory_items i
  where i.tenant_id=10 and i.sku='DELTA-FUEL-ITEM';
  if v_tank_id is null or v_fuel_item_id is null then
    raise exception 'DELTA_BOUNDED_FUEL_EVENT_FIXTURE_DEPENDENCIES_MISSING';
  end if;

  for v_i in 1..501 loop
    select fill_row.fuel_event_id into v_inserted_id
    from public.powerhub_inventory_record_fuel_fill(
      10,100,1,10000,v_fuel_item_id,1,v_tank_id,0.001,
      now() - ((501-v_i)::text || ' seconds')::interval,
      null,null,null,
      'DELTA-BOUND-FE-'||lpad(v_i::text,3,'0'),null,
      'delta-bounded-fuel-event-'||lpad(v_i::text,3,'0')
    ) as fill_row;
    if v_inserted_id is null then
      raise exception 'DELTA_BOUNDED_FUEL_EVENT_FIXTURE_CREATE_FAILED index=%',v_i;
    end if;
  end loop;

  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'fuel_events')
    into v_snapshot;
  v_count:=jsonb_array_length(v_snapshot->'rows');
  select (r->>'id')::bigint into v_moved_id
  from jsonb_array_elements(v_snapshot->'rows') r
  order by (r->>'occurred_at')::timestamptz desc,(r->>'id')::bigint desc
  limit 1;
  with ranked as (
    select e.id,row_number() over(order by e.occurred_at desc,e.id desc) as position
    from public.generator_fuel_events e
    where e.tenant_id=10 and e.site_id=100
  )
  select id into v_replacement_id from ranked where position=501;
  v_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;
  if v_count<>500 or v_moved_id is null or v_replacement_id is null or
     not exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_moved_id::text) or
     exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_id::text) then
    raise exception 'DELTA_FUEL_EVENT_TOP_500_FIXTURE_INVALID count=% moved_id=% replacement_id=%',
      v_count,v_moved_id,v_replacement_id;
  end if;

  -- Reordering a visible event below the bound must reveal the previous #501.
  update public.generator_fuel_events
    set occurred_at=timestamptz '2000-01-01 00:00:00+00'
    where tenant_id=10 and site_id=100 and id=v_moved_id;
  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'fuel_events')
    into v_snapshot;
  if jsonb_array_length(v_snapshot->'rows')<>500 or
     exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_moved_id::text) or
     not exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_id::text) then
    raise exception 'DELTA_FUEL_EVENT_REORDER_DID_NOT_REFILL_TOP_500';
  end if;
  select public.powerhub_pull_fuel_maintenance_sync_delta(
    10,100,'fuel_events',v_cursor,null,500
  ) into v_delta;
  v_change_set:=coalesce(v_delta->'changes','[]'::jsonb);
  while coalesce((v_delta->>'has_more')::boolean,false) loop
    select public.powerhub_pull_fuel_maintenance_sync_delta(
      10,100,'fuel_events',(v_delta->>'next_cursor')::bigint,
      (v_delta->>'through_cursor')::bigint,500
    ) into v_delta;
    v_change_set:=v_change_set||coalesce(v_delta->'changes','[]'::jsonb);
  end loop;
  if not exists(
    select 1 from jsonb_array_elements(v_change_set) c
    where c->>'entity_id'=v_moved_id::text and c->>'operation'='upsert'
  ) or not exists(
    select 1 from jsonb_array_elements(v_change_set) c
    where c->>'entity_id'=v_replacement_id::text and c->>'operation'='upsert'
  ) then raise exception 'DELTA_FUEL_EVENT_REORDER_JOURNAL_DID_NOT_REFILL_TOP_500'; end if;

  -- Restore the event as newest, derive the then-current #501, and test hard deletion independently.
  update public.generator_fuel_events
    set occurred_at=timestamptz '2090-01-01 00:00:00+00'
    where tenant_id=10 and site_id=100 and id=v_moved_id;
  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'fuel_events')
    into v_snapshot;
  with ranked as (
    select e.id,row_number() over(order by e.occurred_at desc,e.id desc) as position
    from public.generator_fuel_events e
    where e.tenant_id=10 and e.site_id=100
  )
  select id into v_replacement_id from ranked where position=501;
  if not exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_moved_id::text) or
     v_replacement_id is null or
     exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_id::text) then
    raise exception 'DELTA_FUEL_EVENT_REORDER_RESTORE_FAILED';
  end if;
  v_cursor:=(v_snapshot->>'snapshot_cursor')::bigint;

  delete from public.generator_fuel_events
    where tenant_id=10 and site_id=100 and id=v_moved_id;
  if exists(select 1 from public.generator_fuel_events where id=v_moved_id) then
    raise exception 'DELTA_FUEL_EVENT_FIXTURE_DELETE_DID_NOT_REMOVE_ROW';
  end if;
  select public.powerhub_get_fuel_maintenance_sync_snapshot(10,100,'fuel_events')
    into v_snapshot;
  if jsonb_array_length(v_snapshot->'rows')<>500 or
     exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_moved_id::text) or
     not exists(select 1 from jsonb_array_elements(v_snapshot->'rows') r where r->>'id'=v_replacement_id::text) then
    raise exception 'DELTA_FUEL_EVENT_DELETE_DID_NOT_REFILL_TOP_500';
  end if;
  select public.powerhub_pull_fuel_maintenance_sync_delta(
    10,100,'fuel_events',v_cursor,null,500
  ) into v_delta;
  v_change_set:=coalesce(v_delta->'changes','[]'::jsonb);
  while coalesce((v_delta->>'has_more')::boolean,false) loop
    select public.powerhub_pull_fuel_maintenance_sync_delta(
      10,100,'fuel_events',(v_delta->>'next_cursor')::bigint,
      (v_delta->>'through_cursor')::bigint,500
    ) into v_delta;
    v_change_set:=v_change_set||coalesce(v_delta->'changes','[]'::jsonb);
  end loop;
  if not exists(
    select 1 from jsonb_array_elements(v_change_set) c
    where c->>'entity_id'=v_moved_id::text and c->>'operation'='delete'
  ) or not exists(
    select 1 from jsonb_array_elements(v_change_set) c
    where c->>'entity_id'=v_replacement_id::text and c->>'operation'='upsert'
  ) then raise exception 'DELTA_FUEL_EVENT_DELETE_JOURNAL_DID_NOT_REFILL_TOP_500'; end if;
end;
$bounded_fuel_event_membership$;

select 'Bounded fuel-event and maintenance Delta snapshot, membership, update, redaction and scope assertions passed' as result;
