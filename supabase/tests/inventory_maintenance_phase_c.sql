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
  v_close_hours numeric;
  v_due_before timestamptz;
  v_plan_replay record;
  v_constraint_name text;
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

  select * into v_plan from public.powerhub_maintenance_create_preventive_plan(
    10,100,1,10000,'MAINT-C-PLAN-01','Oil and filter service','Date and hour based service',
    30,100,now()-interval '1 day',0,7,10,'maint-test-plan-c-01'
  );
  if v_plan.plan_id is null then raise exception 'MAINTENANCE_PLAN_CREATE_FAILED'; end if;
  if not exists(select 1 from public.powerhub_maintenance_evaluate_due_plans(10,100) where plan_id=v_plan.plan_id and alert_type='overdue') then
    raise exception 'MAINTENANCE_OVERDUE_ALERT_MISSING';
  end if;

  select next_due_at into v_due_before from public.generator_maintenance_preventive_plans where id=v_plan.plan_id;

  select * into v_order from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,null,'breakdown','high','Phase C test repair','Disposable integration case',
    now(),null,null,'maint-test-order-c-01'
  );
  if v_order.work_order_id is null or v_order.replayed then raise exception 'MAINTENANCE_CREATE_FAILED'; end if;
  select * into v_replay from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,null,'breakdown','high','Phase C test repair','Disposable integration case',
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

  -- An order's part cannot be attributed to a different generator, even through direct SQL.
  begin
    insert into public.generator_maintenance_work_order_parts(
      tenant_id,site_id,work_order_id,generator_id,item_id,warehouse_id,quantity,unit_cost,total_cost_amount,
      stock_movement_id,operation_key,operation_payload_hash
    ) values(10,100,v_order.work_order_id,999999,v_movement_count,1,1,12.50,12.50,
      999999,'maint-test-cross-generator-part-c','test-hash');
    raise exception 'MAINTENANCE_CROSS_GENERATOR_PART_ACCEPTED';
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint_name = constraint_name;
    if v_constraint_name<>'generator_maintenance_parts_order_fk' then raise; end if;
  end;

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

  if (select next_due_at from public.generator_maintenance_preventive_plans where id=v_plan.plan_id) is distinct from v_due_before
     or (select last_completed_at from public.generator_maintenance_preventive_plans where id=v_plan.plan_id) is not null
     or not exists(select 1 from public.generator_maintenance_alert_events where plan_id=v_plan.plan_id and alert_type='overdue') then
    raise exception 'MAINTENANCE_BREAKDOWN_MUST_NOT_COMPLETE_UNLINKED_PLAN';
  end if;

  -- Null reported_at must replay against the original raw payload.
  select * into v_replay from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,v_plan.plan_id,'preventive','normal','Scheduled oil service','Preventive test',null,null,null,'maint-test-preventive-null-date-c-01'
  );
  if v_replay.replayed then raise exception 'MAINTENANCE_PREVENTIVE_CREATE_FAILED'; end if;
  select * into v_plan_replay from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,v_plan.plan_id,'preventive','normal','Scheduled oil service','Preventive test',null,null,null,'maint-test-preventive-null-date-c-01'
  );
  if not v_plan_replay.replayed or v_plan_replay.work_order_id<>v_replay.work_order_id then
    raise exception 'MAINTENANCE_NULL_REPORTED_AT_IDEMPOTENCY_FAILED';
  end if;
  select * into v_transition from public.powerhub_maintenance_transition_work_order(
    10,100,1,v_replay.work_order_id,'start',null,null,null,0,0,null,'maint-test-preventive-start-c-01'
  );
  if v_transition.status<>'in_progress' then raise exception 'MAINTENANCE_PREVENTIVE_START_FAILED'; end if;
  select greatest(coalesce(g.operating_hours,0),coalesce(max(r.reading_value),0))+1 into v_close_hours
    from public.generators g left join public.generator_fuel_readings r
      on r.tenant_id=g.tenant_id and r.site_id=g.site_id and r.generator_id=g.id
      and r.reading_type='operating_hours' and r.corrects_reading_id is null
    where g.tenant_id=10 and g.site_id=100 and g.id=10000 group by g.operating_hours;
  select * into v_transition from public.powerhub_maintenance_transition_work_order(
    10,100,1,v_replay.work_order_id,'complete','Oil and filters serviced',v_close_hours,20,0,0,null,'maint-test-preventive-complete-c-01'
  );
  if v_transition.status<>'completed' then raise exception 'MAINTENANCE_PREVENTIVE_CLOSEOUT_FAILED'; end if;
  if (select last_completed_at from public.generator_maintenance_preventive_plans where id=v_plan.plan_id) is null
     or (select next_due_operating_hours from public.generator_maintenance_preventive_plans where id=v_plan.plan_id)<>v_close_hours+100
     or not exists(select 1 from public.generator_maintenance_alert_events where plan_id=v_plan.plan_id and alert_type='resolved') then
    raise exception 'MAINTENANCE_LINKED_PLAN_NOT_ADVANCED_OR_ALERT_NOT_RESOLVED';
  end if;

  begin
    perform * from public.powerhub_maintenance_transition_work_order(
      10,100,1,v_order.work_order_id,'start',null,null,null,0,0,null,'maint-test-invalid-start-c-01'
    );
    raise exception 'MAINTENANCE_INVALID_TRANSITION_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_INVALID_STATE_TRANSITION' then raise; end if;
  end;

  if not exists(select 1 from public.generator_maintenance_audit_events where tenant_id=10 and entity_id=v_order.work_order_id and action='complete') then
    raise exception 'MAINTENANCE_AUDIT_EVENT_MISSING';
  end if;

  if has_table_privilege('service_role','public.generator_maintenance_audit_events','UPDATE')
    or has_table_privilege('service_role','public.generator_maintenance_audit_events','DELETE') then
    raise exception 'MAINTENANCE_AUDIT_MUTABLE_ACCESS_GRANTED';
  end if;
  if has_table_privilege('anon','public.generator_maintenance_work_orders','SELECT')
    or has_table_privilege('authenticated','public.generator_maintenance_work_orders','SELECT')
    or has_table_privilege('anon','public.generator_maintenance_preventive_plans','SELECT')
    or has_table_privilege('authenticated','public.generator_maintenance_preventive_plans','SELECT') then
    raise exception 'MAINTENANCE_DIRECT_TABLE_ACCESS_GRANTED';
  end if;
  if has_function_privilege('anon','public.powerhub_maintenance_create_work_order(bigint,bigint,bigint,bigint,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone,bigint,text)','EXECUTE')
    or has_function_privilege('authenticated','public.powerhub_maintenance_create_work_order(bigint,bigint,bigint,bigint,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone,bigint,text)','EXECUTE')
    or not has_function_privilege('service_role','public.powerhub_maintenance_create_work_order(bigint,bigint,bigint,bigint,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone,bigint,text)','EXECUTE') then
    raise exception 'MAINTENANCE_RPC_ACL_FAILED';
  end if;
  if (select count(*) from public.generator_maintenance_audit_events where tenant_id=10 and operation_key='maint-test-part-c-01')<>1 then
    raise exception 'MAINTENANCE_PART_AUDIT_DUPLICATED';
  end if;
end;
$maintenance_phase_c$;

select 'Phase C maintenance work orders, stock issue idempotency, costing, preventive alerts, audit and ACL checks passed' as result;
