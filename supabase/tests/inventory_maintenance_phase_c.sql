\set ON_ERROR_STOP on
-- Reuse the full disposable inventory fixture; never connect to a deployed project.
\ir inventory_purchase_receiving_workflow.sql
\ir ../migrations/20261023090000_powerhub_generator_maintenance.sql

do $maintenance_phase_c$
declare
  v_order record;
  v_replay record;
  v_part record;
  v_part_replay record;
  v_plan record;
  v_transition record;
  v_movement_count bigint;
  v_before numeric;
  v_after numeric;
begin
  -- Create a disposable stock item and seed it through the same audited ledger.
  insert into public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id)
  values(10,'MAINT-PHASE-C-01','Maintenance spare part','spare_part','piece',0,1)
  returning id into v_movement_count;
  perform * from public.powerhub_inventory_record_stock_movement(
    10,100,1,1,v_movement_count,'adjustment_in',10,12.50,null,'MAINT-SEED-C','Disposable maintenance integration fixture','maint-test-seed-c'
  );
  select coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then quantity else -quantity end),0)
    into v_before from public.inventory_stock_movements where tenant_id=10 and site_id=100 and warehouse_id=1 and item_id=v_movement_count;

  select * into v_order from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,'breakdown','high','Phase C test repair','Disposable integration case',
    now(),null,null,'maint-test-order-c-01'
  );
  if v_order.work_order_id is null or v_order.replayed then raise exception 'MAINTENANCE_CREATE_FAILED'; end if;
  select * into v_replay from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,'breakdown','high','Phase C test repair','Disposable integration case',
    (select reported_at from public.generator_maintenance_work_orders where id=v_order.work_order_id),null,null,'maint-test-order-c-01'
  );
  if not v_replay.replayed or v_replay.work_order_id<>v_order.work_order_id then raise exception 'MAINTENANCE_CREATE_IDEMPOTENCY_FAILED'; end if;

  select * into v_part from public.powerhub_maintenance_add_part(
    10,100,1,v_order.work_order_id,v_movement_count,1,2,'Integration test part issue','maint-test-part-c-01'
  );
  if v_part.replayed or v_part.quantity<>2 or v_part.total_cost_amount<>25 then raise exception 'MAINTENANCE_PART_COST_FAILED'; end if;
  select * into v_part_replay from public.powerhub_maintenance_add_part(
    10,100,1,v_order.work_order_id,v_movement_count,1,2,'Integration test part issue','maint-test-part-c-01'
  );
  if not v_part_replay.replayed or v_part_replay.stock_movement_id<>v_part.stock_movement_id then
    raise exception 'MAINTENANCE_PART_IDEMPOTENCY_FAILED';
  end if;
  select coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then quantity else -quantity end),0)
    into v_after from public.inventory_stock_movements where tenant_id=10 and site_id=100 and warehouse_id=1 and item_id=v_movement_count;
  if v_before-v_after<>2 then raise exception 'MAINTENANCE_PART_DUPLICATED_STOCK_ISSUE'; end if;
  select count(*) into v_movement_count from public.generator_maintenance_work_order_parts where tenant_id=10 and work_order_id=v_order.work_order_id;
  if v_movement_count<>1 then raise exception 'MAINTENANCE_PART_ROW_DUPLICATED'; end if;

  select * into v_transition from public.powerhub_maintenance_transition_work_order(
    10,100,1,v_order.work_order_id,'start',null,null,null,0,0,null,'maint-test-start-c-01'
  );
  if v_transition.status<>'in_progress' then raise exception 'MAINTENANCE_START_TRANSITION_FAILED'; end if;
  select * into v_transition from public.powerhub_maintenance_transition_work_order(
    10,100,1,v_order.work_order_id,'complete','Replaced and tested successfully',null,45,30,5,null,'maint-test-complete-c-01'
  );
  if v_transition.status<>'completed' or v_transition.total_cost_amount<>60 then raise exception 'MAINTENANCE_CLOSEOUT_COST_FAILED'; end if;
  select * into v_transition from public.powerhub_maintenance_transition_work_order(
    10,100,1,v_order.work_order_id,'complete','Replaced and tested successfully',null,45,30,5,null,'maint-test-complete-c-01'
  );
  if not v_transition.replayed then raise exception 'MAINTENANCE_TRANSITION_IDEMPOTENCY_FAILED'; end if;

  begin
    perform * from public.powerhub_maintenance_transition_work_order(
      10,100,1,v_order.work_order_id,'start',null,null,null,0,0,null,'maint-test-invalid-start-c-01'
    );
    raise exception 'MAINTENANCE_INVALID_TRANSITION_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_INVALID_STATE_TRANSITION' then raise; end if;
  end;

  select * into v_plan from public.powerhub_maintenance_create_preventive_plan(
    10,100,1,10000,'MAINT-C-PLAN-01','Oil and filter service','Date and hour based service',
    30,100,now()-interval '1 day',0,7,10,'maint-test-plan-c-01'
  );
  if v_plan.plan_id is null then raise exception 'MAINTENANCE_PLAN_CREATE_FAILED'; end if;
  if not exists(select 1 from public.powerhub_maintenance_evaluate_due_plans(10,100) where plan_id=v_plan.plan_id and alert_type='overdue') then
    raise exception 'MAINTENANCE_OVERDUE_ALERT_MISSING';
  end if;
  if not exists(select 1 from public.generator_maintenance_audit_events where tenant_id=10 and entity_id=v_order.work_order_id and action='complete') then
    raise exception 'MAINTENANCE_AUDIT_EVENT_MISSING';
  end if;

  if has_table_privilege('anon','public.generator_maintenance_work_orders','SELECT')
    or has_table_privilege('authenticated','public.generator_maintenance_work_orders','SELECT')
    or has_table_privilege('anon','public.generator_maintenance_preventive_plans','SELECT')
    or has_table_privilege('authenticated','public.generator_maintenance_preventive_plans','SELECT') then
    raise exception 'MAINTENANCE_DIRECT_TABLE_ACCESS_GRANTED';
  end if;
  if has_function_privilege('anon','public.powerhub_maintenance_create_work_order(bigint,bigint,bigint,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone,bigint,text)','EXECUTE')
    or has_function_privilege('authenticated','public.powerhub_maintenance_create_work_order(bigint,bigint,bigint,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone,bigint,text)','EXECUTE')
    or not has_function_privilege('service_role','public.powerhub_maintenance_create_work_order(bigint,bigint,bigint,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone,bigint,text)','EXECUTE') then
    raise exception 'MAINTENANCE_RPC_ACL_FAILED';
  end if;
  if (select count(*) from public.generator_maintenance_audit_events where tenant_id=10 and operation_key='maint-test-part-c-01')<>1 then
    raise exception 'MAINTENANCE_PART_AUDIT_DUPLICATED';
  end if;
end;
$maintenance_phase_c$;

select 'Phase C maintenance work orders, stock issue idempotency, costing, preventive alerts, audit and ACL checks passed' as result;
