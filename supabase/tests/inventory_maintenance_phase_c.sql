\set ON_ERROR_STOP on
-- Reuse the full disposable inventory fixture; never connect to a deployed project.
\ir inventory_purchase_receiving_workflow.sql
\ir ../migrations/20261023090000_powerhub_generator_maintenance.sql

-- Deliberately fail only the audit write for one maintenance-part test operation.
-- The RPC must roll back its earlier stock movement and part/header writes atomically.
create or replace function public.fail_maintenance_part_audit_for_test()
returns trigger language plpgsql as $trigger$
begin
  if new.entity_type='work_order_part'
    and new.action='issue'
    and new.operation_key='maint-test-part-rollback-c-01' then
    raise exception 'FORCED_MAINTENANCE_PART_AUDIT_FAILURE' using errcode='P0001';
  end if;
  return new;
end;
$trigger$;
drop trigger if exists fail_maintenance_part_audit_for_test on public.generator_maintenance_audit_events;
create trigger fail_maintenance_part_audit_for_test
  before insert on public.generator_maintenance_audit_events
  for each row execute function public.fail_maintenance_part_audit_for_test();

do $maintenance_phase_c$
declare
  v_order record;
  v_replay record;
  v_part record;
  v_part_replay record;
  v_plan record;
  v_transition record;
  v_movement_count bigint;
  v_item_id bigint;
  v_before numeric;
  v_after numeric;
  v_close_hours numeric;
  v_due_before timestamptz;
  v_plan_replay record;
  v_constraint_name text;
  v_notification_count_before bigint;
  v_notification_count_after bigint;
  v_report_rows bigint;
  v_report_cost numeric;
  v_supplier_id bigint;
  v_supplier_assign record;
  v_supplier_assign_replay record;
  v_correction_generator_id bigint;
  v_order_generator_id bigint;
  v_correction_original_reading_id bigint;
  v_correction_plan record;
  v_correction_alert record;
  v_correction_parts_before bigint;
  v_correction_readings_before bigint;
  v_correction_completed_at timestamptz;
  v_correction_cost_before numeric;
  v_reopen record;
  v_reopen_replay record;
  v_reopened_order_id bigint;
  v_recurring_order record;
  v_source_snapshot jsonb;
  v_foreign_generator_id bigint;
  v_foreign_item_id bigint;
  v_failed_stock_key text;
  v_failed_stock_count bigint;
  v_failed_part_count bigint;
  v_failed_audit_count bigint;
  v_failed_balance numeric(14,3);
  v_failed_parts_cost numeric(14,2);
  v_failure_message text;
  v_failure_triggered boolean:=false;
begin
  -- Partial tenant/site scope must not turn into an unbounded evaluator.
  begin
    perform * from public.powerhub_maintenance_evaluate_due_plans(null,100);
    raise exception 'MAINTENANCE_PARTIAL_EVALUATOR_SCOPE_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_SCOPE_REQUIRED' then raise; end if;
  end;

  -- Create a disposable stock item and seed it through the same audited ledger.
  insert into public.inventory_items(tenant_id,sku,name,category,base_unit,reorder_point,created_by_user_id)
  values(10,'MAINT-PHASE-C-01','Maintenance spare part','spare_part','piece',0,1)
  returning id into v_item_id;
  perform * from public.powerhub_inventory_record_stock_movement(
    10,100,1,1,v_item_id,'adjustment_in',10,12.50,null,'MAINT-SEED-C','Disposable maintenance integration fixture','maint-test-seed-c'
  );
  select coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then quantity else -quantity end),0)
    into v_before from public.inventory_stock_movements where tenant_id=10 and site_id=100 and warehouse_id=1 and item_id=v_item_id;

  select * into v_plan from public.powerhub_maintenance_create_preventive_plan(
    10,100,1,10000,'MAINT-C-PLAN-01','Oil and filter service','Date and hour based service',
    30,100,now()-interval '1 day',0,7,10,'maint-test-plan-c-01'
  );
  if v_plan.plan_id is null then raise exception 'MAINTENANCE_PLAN_CREATE_FAILED'; end if;
  if not exists(select 1 from public.powerhub_maintenance_evaluate_due_plans(10,100) where plan_id=v_plan.plan_id and alert_type='overdue') then
    raise exception 'MAINTENANCE_OVERDUE_ALERT_MISSING';
  end if;
  select count(*) into v_notification_count_before from public.powerhub_user_notifications
    where tenant_id=10 and entity_type='maintenance_alert' and metadata->>'plan_id'=v_plan.plan_id::text;
  if v_notification_count_before<>1 then raise exception 'MAINTENANCE_ALERT_NOTIFICATION_MISSING'; end if;
  perform * from public.powerhub_maintenance_evaluate_due_plans(10,100);
  select count(*) into v_notification_count_after from public.powerhub_user_notifications
    where tenant_id=10 and entity_type='maintenance_alert' and metadata->>'plan_id'=v_plan.plan_id::text;
  if v_notification_count_after<>v_notification_count_before then raise exception 'MAINTENANCE_ALERT_NOTIFICATION_DUPLICATED'; end if;

  select next_due_at into v_due_before from public.generator_maintenance_preventive_plans where id=v_plan.plan_id;

  select * into v_order from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,null,'breakdown','high','Phase C test repair','Disposable integration case',
    now(),null,null,'maint-test-order-c-01'
  );
  if v_order.work_order_id is null or v_order.replayed then raise exception 'MAINTENANCE_CREATE_FAILED'; end if;

  -- A generator belonging to another tenant must not be accepted by a tenant/site-scoped order RPC.
  select id into v_foreign_generator_id from public.generators
  where tenant_id=20 and site_id=200 and id=20000;
  begin
    perform * from public.powerhub_maintenance_create_work_order(
      10,100,1,v_foreign_generator_id,null,'breakdown','high',
      'Cross-tenant generator must fail','Disposable scope assertion',
      now(),null,null,'maint-test-cross-tenant-generator-c-01'
    );
    raise exception 'MAINTENANCE_CROSS_TENANT_GENERATOR_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_GENERATOR_OUT_OF_SCOPE' then raise; end if;
  end;
  if exists(select 1 from public.generator_maintenance_work_orders
      where tenant_id=10 and operation_key='maint-test-cross-tenant-generator-c-01') then
    raise exception 'MAINTENANCE_CROSS_TENANT_GENERATOR_LEFT_ORDER';
  end if;

  select id into v_supplier_id from public.suppliers where tenant_id=10 and supplier_code='PUR-WF-SUP' and is_active=true;
  if v_supplier_id is null then raise exception 'MAINTENANCE_TEST_SUPPLIER_MISSING'; end if;
  select * into v_supplier_assign from public.powerhub_maintenance_assign_supplier(
    10,100,1,v_order.work_order_id,v_supplier_id,'maint-test-assign-supplier-c-01'
  );
  if v_supplier_assign.replayed or v_supplier_assign.assigned_supplier_id<>v_supplier_id then raise exception 'MAINTENANCE_SUPPLIER_ASSIGNMENT_FAILED'; end if;
  select * into v_supplier_assign_replay from public.powerhub_maintenance_assign_supplier(
    10,100,1,v_order.work_order_id,v_supplier_id,'maint-test-assign-supplier-c-01'
  );
  if not v_supplier_assign_replay.replayed or v_supplier_assign_replay.assigned_supplier_id<>v_supplier_id then raise exception 'MAINTENANCE_SUPPLIER_ASSIGNMENT_IDEMPOTENCY_FAILED'; end if;
  if (select count(*) from public.generator_maintenance_audit_events where tenant_id=10 and operation_key='maint-test-assign-supplier-c-01' and action='assign_supplier')<>1 then raise exception 'MAINTENANCE_SUPPLIER_ASSIGNMENT_AUDIT_DUPLICATED'; end if;
  if has_function_privilege('anon','public.powerhub_maintenance_assign_supplier(bigint,bigint,bigint,bigint,bigint,text)','EXECUTE')
    or has_function_privilege('authenticated','public.powerhub_maintenance_assign_supplier(bigint,bigint,bigint,bigint,bigint,text)','EXECUTE')
    or not has_function_privilege('service_role','public.powerhub_maintenance_assign_supplier(bigint,bigint,bigint,bigint,bigint,text)','EXECUTE') then
    raise exception 'MAINTENANCE_SUPPLIER_ASSIGNMENT_ACL_FAILED';
  end if;
  if not has_sequence_privilege('service_role','public.generator_maintenance_work_order_number_seq','USAGE')
    or not has_sequence_privilege('service_role','public.generator_maintenance_work_order_number_seq','SELECT') then
    raise exception 'MAINTENANCE_WORK_ORDER_NUMBER_SEQUENCE_ACL_FAILED';
  end if;
  begin
    perform * from public.powerhub_maintenance_assign_supplier(10,100,1,v_order.work_order_id,null,'maint-test-assign-supplier-c-01');
    raise exception 'MAINTENANCE_SUPPLIER_ASSIGNMENT_KEY_REUSE_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_IDEMPOTENCY_KEY_REUSED' then raise; end if;
  end;
  begin
    perform * from public.powerhub_maintenance_assign_supplier(
      10,100,1,v_order.work_order_id,(select id from public.suppliers where tenant_id=20 and supplier_code='SUP-01' limit 1),
      'maint-test-assign-cross-tenant-c-01'
    );
    raise exception 'MAINTENANCE_CROSS_TENANT_SUPPLIER_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_SUPPLIER_OUT_OF_SCOPE' then raise; end if;
  end;
  select * into v_replay from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,null,'breakdown','high','Phase C test repair','Disposable integration case',
    (select reported_at from public.generator_maintenance_work_orders where id=v_order.work_order_id),null,null,'maint-test-order-c-01'
  );
  if not v_replay.replayed or v_replay.work_order_id<>v_order.work_order_id then raise exception 'MAINTENANCE_CREATE_IDEMPOTENCY_FAILED'; end if;

  -- Object-reference isolation: a work-order ID from a different site and an item
  -- from another tenant must fail before a stock movement or part row is created.
  begin
    perform * from public.powerhub_maintenance_add_part(
      10,101,1,v_order.work_order_id,v_item_id,1,1,'Cross-site work order probe',
      'maint-test-cross-site-order-c-01'
    );
    raise exception 'MAINTENANCE_CROSS_SITE_WORK_ORDER_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_WORK_ORDER_NOT_FOUND' then raise; end if;
  end;

  select id into v_foreign_item_id from public.inventory_items
  where tenant_id=20 and sku='DSL-01' and is_active=true;
  begin
    perform * from public.powerhub_maintenance_add_part(
      10,100,1,v_order.work_order_id,v_foreign_item_id,1,1,'Cross-tenant item probe',
      'maint-test-cross-tenant-item-c-01'
    );
    raise exception 'MAINTENANCE_CROSS_TENANT_ITEM_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_PART_ITEM_OUT_OF_SCOPE' then raise; end if;
  end;

  -- Force the final audit insert to fail after the nested stock movement succeeds.
  -- PostgreSQL must roll back every write from the RPC statement as one transaction.
  v_failed_stock_key:='maint-part:10:'||md5('maint-test-part-rollback-c-01');
  select coalesce(sum(case when movement_type in
    ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
    then quantity else -quantity end),0)
    into v_failed_balance
  from public.inventory_stock_movements
  where tenant_id=10 and site_id=100 and warehouse_id=1 and item_id=v_item_id;
  select parts_cost into v_failed_parts_cost from public.generator_maintenance_work_orders
  where tenant_id=10 and site_id=100 and id=v_order.work_order_id;
  v_failure_triggered:=false;
  begin
    perform * from public.powerhub_maintenance_add_part(
      10,100,1,v_order.work_order_id,v_item_id,1,1,'Atomic rollback probe',
      'maint-test-part-rollback-c-01'
    );
    raise exception 'MAINTENANCE_PART_AUDIT_FAILURE_NOT_TRIGGERED';
  exception when others then
    get stacked diagnostics v_failure_message=message_text;
    if v_failure_message='MAINTENANCE_PART_AUDIT_FAILURE_NOT_TRIGGERED' then raise; end if;
    if v_failure_message<>'FORCED_MAINTENANCE_PART_AUDIT_FAILURE' then raise; end if;
    v_failure_triggered:=true;
  end;
  if not v_failure_triggered then raise exception 'MAINTENANCE_PART_AUDIT_FAILURE_NOT_OBSERVED'; end if;
  select coalesce(sum(case when movement_type in
    ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
    then quantity else -quantity end),0)
    into v_after
  from public.inventory_stock_movements
  where tenant_id=10 and site_id=100 and warehouse_id=1 and item_id=v_item_id;
  select count(*) into v_failed_stock_count from public.inventory_stock_movements
  where tenant_id=10 and site_id=100 and operation_key=v_failed_stock_key;
  select count(*) into v_failed_part_count from public.generator_maintenance_work_order_parts
  where tenant_id=10 and site_id=100 and operation_key='maint-test-part-rollback-c-01';
  select count(*) into v_failed_audit_count from public.generator_maintenance_audit_events
  where tenant_id=10 and site_id=100 and operation_key='maint-test-part-rollback-c-01';
  if v_after<>v_failed_balance or v_failed_stock_count<>0 or
     v_failed_part_count<>0 or v_failed_audit_count<>0 or
     (select parts_cost from public.generator_maintenance_work_orders
       where tenant_id=10 and site_id=100 and id=v_order.work_order_id) is distinct from v_failed_parts_cost then
    raise exception 'MAINTENANCE_PART_AUDIT_FAILURE_NOT_ATOMIC balance_before=% balance_after=% stock=% parts=% audit=%',
      v_failed_balance,v_after,v_failed_stock_count,v_failed_part_count,v_failed_audit_count;
  end if;

  select * into v_part from public.powerhub_maintenance_add_part(
    10,100,1,v_order.work_order_id,v_item_id,1,2,'Integration test part issue','maint-test-part-c-01'
  );
  if v_part.replayed or v_part.quantity<>2 or v_part.total_cost_amount<>25 then raise exception 'MAINTENANCE_PART_COST_FAILED'; end if;
  select * into v_part_replay from public.powerhub_maintenance_add_part(
    10,100,1,v_order.work_order_id,v_item_id,1,2,'Integration test part issue','maint-test-part-c-01'
  );
  if not v_part_replay.replayed or v_part_replay.stock_movement_id<>v_part.stock_movement_id then
    raise exception 'MAINTENANCE_PART_IDEMPOTENCY_FAILED';
  end if;
  select coalesce(sum(case when movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue') then quantity else -quantity end),0)
    into v_after from public.inventory_stock_movements where tenant_id=10 and site_id=100 and warehouse_id=1 and item_id=v_item_id;
  if v_before-v_after<>2 then raise exception 'MAINTENANCE_PART_DUPLICATED_STOCK_ISSUE'; end if;
  select count(*) into v_movement_count from public.generator_maintenance_work_order_parts where tenant_id=10 and work_order_id=v_order.work_order_id;
  if v_movement_count<>1 then raise exception 'MAINTENANCE_PART_ROW_DUPLICATED'; end if;

  -- An order's part cannot be attributed to a different generator, even through direct SQL.
  begin
    insert into public.generator_maintenance_work_order_parts(
      tenant_id,site_id,work_order_id,generator_id,item_id,warehouse_id,quantity,unit_cost,total_cost_amount,
      stock_movement_id,operation_key,operation_payload_hash
    ) values(10,100,v_order.work_order_id,999999,v_item_id,1,1,12.50,12.50,
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

  -- A completed-order correction is audited and record-only: no duplicate stock issue,
  -- no second operating-hour reading, no change to the original completion timestamp.
  select count(*) into v_correction_parts_before
    from public.generator_maintenance_work_order_parts
    where tenant_id=10 and site_id=100 and work_order_id=v_order.work_order_id;
  select generator_id into v_order_generator_id
    from public.generator_maintenance_work_orders
    where tenant_id=10 and site_id=100 and id=v_order.work_order_id;
  if v_order_generator_id is null then raise exception 'MAINTENANCE_CORRECTION_ORDER_GENERATOR_MISSING'; end if;
  select count(*) into v_correction_readings_before
    from public.generator_fuel_readings
    where tenant_id=10 and site_id=100 and generator_id=v_order_generator_id
      and reading_type='operating_hours';
  select completed_at,total_cost_amount into v_correction_completed_at,v_correction_cost_before
    from public.generator_maintenance_work_orders where id=v_order.work_order_id;

  select * into v_transition from public.powerhub_maintenance_transition_work_order(
    10,100,1,v_order.work_order_id,'correct_completion',
    'Replaced and tested; corrected record',null,46,32,6,
    'Corrected technician cost and downtime','maint-test-correct-completion-c-01'
  );
  if v_transition.status<>'completed' or v_transition.total_cost_amount<>63 then
    raise exception 'MAINTENANCE_COMPLETION_CORRECTION_COST_FAILED';
  end if;
  begin
    perform * from public.powerhub_maintenance_transition_work_order(
      10,100,1,v_order.work_order_id,'correct_completion',
      'Replaced and tested; corrected record',null,46,null,6,
      'Corrected technician cost and downtime','maint-test-correct-completion-c-01'
    );
    raise exception 'MAINTENANCE_COMPLETION_CORRECTION_IDEMPOTENCY_PAYLOAD_CONFLICT_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_IDEMPOTENCY_KEY_REUSED' then raise; end if;
  end;
  if (select completed_at from public.generator_maintenance_work_orders where id=v_order.work_order_id)
       is distinct from v_correction_completed_at then
    raise exception 'MAINTENANCE_COMPLETION_CORRECTION_CHANGED_COMPLETION_TIME';
  end if;
  if (select count(*) from public.generator_maintenance_work_order_parts
      where tenant_id=10 and site_id=100 and work_order_id=v_order.work_order_id)<>v_correction_parts_before then
    raise exception 'MAINTENANCE_COMPLETION_CORRECTION_DUPLICATED_STOCK';
  end if;
  if (select count(*) from public.generator_fuel_readings
      where tenant_id=10 and site_id=100 and generator_id=v_order_generator_id
        and reading_type='operating_hours')<>v_correction_readings_before then
    raise exception 'MAINTENANCE_COMPLETION_CORRECTION_DUPLICATED_METER_READING';
  end if;
  if not exists(select 1 from public.generator_maintenance_audit_events
      where tenant_id=10 and site_id=100 and entity_type='work_order'
        and entity_id=v_order.work_order_id and action='correct_completion'
        and after_data->>'reason'='Corrected technician cost and downtime'
        and before_data->>'status'='completed') then
    raise exception 'MAINTENANCE_COMPLETION_CORRECTION_AUDIT_MISSING';
  end if;

  select jsonb_build_object('status',status,'completed_at',completed_at,'total_cost_amount',total_cost_amount,
    'operating_hours_at_close',operating_hours_at_close,'parts_cost',parts_cost)
    into v_source_snapshot from public.generator_maintenance_work_orders
    where tenant_id=10 and site_id=100 and id=v_order.work_order_id;
  select * into v_reopen from public.powerhub_maintenance_reopen_completed_work_order(
    10,100,1,v_order.work_order_id,'Follow-up repair after verification','maint-test-reopen-c-01'
  );
  if v_reopen.status<>'new' or v_reopen.replayed or v_reopen.source_work_order_id<>v_order.work_order_id
     or v_reopen.work_order_id=v_order.work_order_id then
    raise exception 'MAINTENANCE_REOPEN_NEW_CYCLE_FAILED';
  end if;
  v_reopened_order_id:=v_reopen.work_order_id;
  select * into v_reopen_replay from public.powerhub_maintenance_reopen_completed_work_order(
    10,100,1,v_order.work_order_id,'Follow-up repair after verification','maint-test-reopen-c-01'
  );
  if not v_reopen_replay.replayed or v_reopen_replay.work_order_id<>v_reopened_order_id then
    raise exception 'MAINTENANCE_REOPEN_IDEMPOTENCY_FAILED';
  end if;
  if (select jsonb_build_object('status',status,'completed_at',completed_at,'total_cost_amount',total_cost_amount,
      'operating_hours_at_close',operating_hours_at_close,'parts_cost',parts_cost)
      from public.generator_maintenance_work_orders where tenant_id=10 and site_id=100 and id=v_order.work_order_id)
      is distinct from v_source_snapshot then
    raise exception 'MAINTENANCE_REOPEN_SOURCE_MUTATED';
  end if;
  if not exists(select 1 from public.generator_maintenance_audit_events
    where tenant_id=10 and site_id=100 and entity_type='work_order' and entity_id=v_reopened_order_id
      and action='reopen_completed' and before_data->>'source_work_order_id'=v_order.work_order_id::text
      and after_data->>'reason'='Follow-up repair after verification') then
    raise exception 'MAINTENANCE_REOPEN_AUDIT_MISSING';
  end if;
  if (select count(*) from public.generator_maintenance_work_order_parts
      where tenant_id=10 and site_id=100 and work_order_id=v_reopened_order_id)<>0
     or (select parts_cost from public.generator_maintenance_work_orders where id=v_reopened_order_id)<>0 then
    raise exception 'MAINTENANCE_REOPEN_DUPLICATED_PARTS_OR_COST';
  end if;

  -- A later recurrence of the same breakdown is a new auditable work-order cycle.
  -- It must not reopen or overwrite the completed source order or inherit old parts/costs.
  select * into v_recurring_order from public.powerhub_maintenance_create_work_order(
    10,100,1,10000,null,'breakdown','high','Phase C test repair','Recurring breakdown after completed repair',
    '2026-10-24T12:00:00Z',null,null,'maint-test-recurring-breakdown-c-01'
  );
  if v_recurring_order.replayed or v_recurring_order.work_order_id in (v_order.work_order_id,v_reopened_order_id)
     or v_recurring_order.status<>'new' then
    raise exception 'MAINTENANCE_RECURRING_BREAKDOWN_NOT_NEW_CYCLE';
  end if;
  if (select status from public.generator_maintenance_work_orders where id=v_order.work_order_id)<>'completed'
     or (select count(*) from public.generator_maintenance_work_order_parts
         where tenant_id=10 and site_id=100 and work_order_id=v_recurring_order.work_order_id)<>0
     or (select parts_cost from public.generator_maintenance_work_orders where id=v_recurring_order.work_order_id)<>0 then
    raise exception 'MAINTENANCE_RECURRING_BREAKDOWN_MUTATED_OR_INHERITED_HISTORY';
  end if;
  begin
    perform * from public.powerhub_maintenance_reopen_completed_work_order(
      10,100,1,v_order.work_order_id,'','maint-test-reopen-no-reason-c-01'
    );
    raise exception 'MAINTENANCE_REOPEN_WITHOUT_REASON_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_REOPEN_REASON_REQUIRED' then raise; end if;
  end;
  begin
    perform * from public.powerhub_maintenance_reopen_completed_work_order(
      10,100,1,v_order.work_order_id,'Concurrent duplicate follow-up','maint-test-reopen-c-02'
    );
    raise exception 'MAINTENANCE_DUPLICATE_OPEN_FOLLOWUP_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_FOLLOWUP_ALREADY_OPEN' then raise; end if;
  end;
  begin
    perform * from public.powerhub_maintenance_reopen_completed_work_order(
      10,100,1,v_order.work_order_id,'Different reason','maint-test-reopen-c-01'
    );
    raise exception 'MAINTENANCE_REOPEN_KEY_REUSE_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_IDEMPOTENCY_KEY_REUSED' then raise; end if;
  end;
  begin
    perform * from public.powerhub_maintenance_transition_work_order(
      10,100,1,v_order.work_order_id,'correct_completion',
      'Invalid correction',null,null,null,null,null,'maint-test-correction-no-reason-c-01'
    );
    raise exception 'MAINTENANCE_COMPLETION_CORRECTION_WITHOUT_REASON_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_COMPLETION_CORRECTION_REASON_REQUIRED' then raise; end if;
  end;

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
  begin
    select * into v_plan_replay from public.powerhub_maintenance_create_work_order(
      10,100,1,10000,v_plan.plan_id,'preventive','normal','Duplicate preventive service','Preventive duplicate guard',
      null,null,null,'maint-test-preventive-duplicate-c-01'
    );
    raise exception 'MAINTENANCE_DUPLICATE_OPEN_PREVENTIVE_ACCEPTED';
  exception when unique_violation then
    get stacked diagnostics v_constraint_name = constraint_name;
    if v_constraint_name<>'generator_maintenance_work_orders_preventive_open_plan_unique' then raise; end if;
  end;
  select * into v_transition from public.powerhub_maintenance_transition_work_order(
    10,100,1,v_replay.work_order_id,'start',null,null,null,0,0,null,'maint-test-preventive-start-c-01'
  );
  if v_transition.status<>'in_progress' then raise exception 'MAINTENANCE_PREVENTIVE_START_FAILED'; end if;
  select greatest(coalesce(g.operating_hours,0),coalesce(max(r.reading_value),0)) into v_close_hours
    from public.generators g left join public.generator_fuel_readings r
      on r.tenant_id=g.tenant_id and r.site_id=g.site_id and r.generator_id=g.id
      and r.reading_type='operating_hours'
      and not exists (
        select 1 from public.generator_fuel_readings correction
        where correction.tenant_id=r.tenant_id and correction.corrects_reading_id=r.id
      )
    where g.tenant_id=10 and g.site_id=100 and g.id=10000 group by g.operating_hours;

  -- A close-out below the latest effective meter reading must roll back all earlier writes.
  begin
    perform * from public.powerhub_maintenance_transition_work_order(
      10,100,1,v_replay.work_order_id,'complete','Oil and filters serviced',v_close_hours-1,20,0,0,null,'maint-test-preventive-invalid-close-c-01'
    );
    raise exception 'MAINTENANCE_INVALID_METER_CLOSEOUT_ACCEPTED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'MAINTENANCE_HOURS_BACKWARDS' then raise; end if;
  end;
  if (select status from public.generator_maintenance_work_orders where id=v_replay.work_order_id)<>'in_progress'
     or (select last_completed_at from public.generator_maintenance_preventive_plans where id=v_plan.plan_id) is not null
     or exists(select 1 from public.generator_fuel_readings
       where tenant_id=10 and operation_key='maintenance-closeout-hours:'||v_replay.work_order_id::text)
  then raise exception 'MAINTENANCE_CLOSEOUT_FAILURE_NOT_ATOMIC'; end if;

  select * into v_transition from public.powerhub_maintenance_transition_work_order(
    10,100,1,v_replay.work_order_id,'complete','Oil and filters serviced',v_close_hours,20,0,0,null,'maint-test-preventive-complete-c-01'
  );
  if v_transition.status<>'completed' then raise exception 'MAINTENANCE_PREVENTIVE_CLOSEOUT_FAILED'; end if;
  if not exists(select 1 from public.generator_fuel_readings r
    where r.tenant_id=10 and r.site_id=100 and r.generator_id=10000
      and r.reading_type='operating_hours' and r.tank_warehouse_id is null
      and r.reading_value=v_close_hours
      and r.operation_key='maintenance-closeout-hours:'||v_replay.work_order_id::text
      and r.created_by_user_id=1) then
    raise exception 'MAINTENANCE_CLOSEOUT_HOURS_READING_MISSING';
  end if;
  select * into v_transition from public.powerhub_maintenance_transition_work_order(
    10,100,1,v_replay.work_order_id,'complete','Oil and filters serviced',v_close_hours,20,0,0,null,'maint-test-preventive-complete-c-01'
  );
  if not v_transition.replayed then raise exception 'MAINTENANCE_CLOSEOUT_REPLAY_FAILED'; end if;
  if (select count(*) from public.generator_fuel_readings
      where tenant_id=10 and operation_key='maintenance-closeout-hours:'||v_replay.work_order_id::text)<>1 then
    raise exception 'MAINTENANCE_CLOSEOUT_HOURS_READING_DUPLICATED';
  end if;
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
  if has_function_privilege('anon','public.powerhub_maintenance_report_by_generator(bigint,bigint,date,date,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.powerhub_maintenance_report_by_generator(bigint,bigint,date,date,bigint)','EXECUTE')
    or not has_function_privilege('service_role','public.powerhub_maintenance_report_by_generator(bigint,bigint,date,date,bigint)','EXECUTE') then
    raise exception 'MAINTENANCE_REPORT_RPC_ACL_FAILED';
  end if;
  if has_function_privilege('anon','public.powerhub_maintenance_create_work_order(bigint,bigint,bigint,bigint,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone,bigint,text)','EXECUTE')
    or has_function_privilege('authenticated','public.powerhub_maintenance_create_work_order(bigint,bigint,bigint,bigint,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone,bigint,text)','EXECUTE')
    or not has_function_privilege('service_role','public.powerhub_maintenance_create_work_order(bigint,bigint,bigint,bigint,bigint,text,text,text,text,timestamp with time zone,timestamp with time zone,bigint,text)','EXECUTE') then
    raise exception 'MAINTENANCE_RPC_ACL_FAILED';
  end if;
  if (select count(*) from public.generator_maintenance_audit_events where tenant_id=10 and operation_key='maint-test-part-c-01')<>1 then
    raise exception 'MAINTENANCE_PART_AUDIT_DUPLICATED';
  end if;

  select count(*) into v_report_rows from public.powerhub_maintenance_report_by_generator(
    10,100,(now() at time zone 'Asia/Gaza')::date-1,(now() at time zone 'Asia/Gaza')::date+1,null
  );
  if v_report_rows<2 then raise exception 'MAINTENANCE_REPORT_MISSING_WORK_ORDER_GROUPS'; end if;
  select coalesce(sum(r.total_cost_amount),0) into v_report_cost from public.powerhub_maintenance_report_by_generator(
    10,100,(now() at time zone 'Asia/Gaza')::date-1,(now() at time zone 'Asia/Gaza')::date+1,null
  ) r;
  if v_report_cost<>63 then raise exception 'MAINTENANCE_REPORT_COST_RECONCILIATION_FAILED'; end if;
  if (select coalesce(sum(r.downtime_minutes),0) from public.powerhub_maintenance_report_by_generator(
    10,100,(now() at time zone 'Asia/Gaza')::date-1,(now() at time zone 'Asia/Gaza')::date+1,null
  ) r)<>66 then raise exception 'MAINTENANCE_REPORT_DOWNTIME_RECONCILIATION_FAILED'; end if;
  if exists(select 1 from public.powerhub_maintenance_report_by_generator(
    10,100,(now() at time zone 'Asia/Gaza')::date-1,(now() at time zone 'Asia/Gaza')::date+1,20000
  )) then raise exception 'MAINTENANCE_REPORT_GENERATOR_SCOPE_FAILED'; end if;
  begin
    perform * from public.powerhub_maintenance_report_by_generator(
      10,100,(now() at time zone 'Asia/Gaza')::date-400,(now() at time zone 'Asia/Gaza')::date,null
    );
    raise exception 'MAINTENANCE_REPORT_RANGE_LIMIT_NOT_ENFORCED';
  exception when sqlstate 'P0001' then
    if sqlerrm<>'INVALID_MAINTENANCE_REPORT_RANGE' then raise; end if;
  end;

  -- A documented downward correction must supersede the old meter row in due evaluation.
  insert into public.generators(id,tenant_id,site_id,name,fuel_type,operating_hours)
  values (30000,10,100,'Maintenance correction regression','diesel',0)
  returning id into v_correction_generator_id;

  select reading_id into v_correction_original_reading_id
    from public.powerhub_inventory_record_fuel_reading(
      10,100,1,v_correction_generator_id,'operating_hours',null,100,
      now()-interval '2 hours','MAINT-C-HOURS-ORIGINAL','Original meter for correction regression',
      null,null,'maint-c-hours-original-c-01'
    );
  if v_correction_original_reading_id is null then
    raise exception 'MAINTENANCE_CORRECTION_FIXTURE_READING_MISSING';
  end if;

  perform * from public.powerhub_inventory_record_fuel_reading(
    10,100,1,v_correction_generator_id,'operating_hours',null,98,
    now()-interval '1 hour','MAINT-C-HOURS-CORRECTED','Corrected meter entry downward',
    v_correction_original_reading_id,'Correction of transcription','maint-c-hours-corrected-c-01'
  );

  select * into v_correction_plan from public.powerhub_maintenance_create_preventive_plan(
    10,100,1,v_correction_generator_id,'MAINT-C-CORR-PLAN-01',
    'Meter correction regression','Due hours must use the latest effective reading',
    null,10,null,99,0,1,'maint-c-correction-plan-01'
  );
  select * into v_correction_alert
    from public.powerhub_maintenance_evaluate_due_plans(10,100)
    where plan_id=v_correction_plan.plan_id;
  if not found or v_correction_alert.alert_type<>'due_soon'
     or v_correction_alert.observed_operating_hours<>98 then
    raise exception 'MAINTENANCE_CORRECTED_HOURS_FALSE_OVERDUE_ALERT';
  end if;
end;
$maintenance_phase_c$;

drop trigger if exists fail_maintenance_part_audit_for_test on public.generator_maintenance_audit_events;
drop function if exists public.fail_maintenance_part_audit_for_test();

select 'Phase C maintenance work orders, stock issue idempotency, costing, preventive alerts, audit and ACL checks passed' as result;

-- This fixture tests only the operational feeds, so provide the shared journal tables
-- without installing the core Delta migration's unrelated subscribers/sites triggers.
create table if not exists public.powerhub_sync_scope_state (
  tenant_id bigint not null,
  site_id bigint not null,
  entity_type text not null,
  last_cursor bigint not null default 0 check (last_cursor >= 0),
  retained_from_cursor bigint not null default 0 check (retained_from_cursor >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id,site_id,entity_type),
  check (retained_from_cursor <= last_cursor)
);
create table if not exists public.powerhub_sync_changes (
  tenant_id bigint not null,
  site_id bigint not null,
  entity_type text not null,
  cursor bigint not null check (cursor > 0),
  entity_id text not null check (length(entity_id) between 1 and 100),
  change_type text not null check (change_type in ('upsert','delete')),
  row_data jsonb,
  changed_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id,site_id,entity_type,cursor),
  check ((change_type='upsert' and row_data is not null) or (change_type='delete' and row_data is null))
);
create index if not exists powerhub_sync_changes_entity_idx
  on public.powerhub_sync_changes(tenant_id,site_id,entity_type,entity_id,cursor desc);

\ir ../migrations/20261029130000_powerhub_delta_fuel_maintenance_read_models.sql
\ir ../migrations/20261029140000_powerhub_delta_fuel_events_maintenance_orders_parts.sql
\ir fuel_maintenance_delta_sync_history.sql
