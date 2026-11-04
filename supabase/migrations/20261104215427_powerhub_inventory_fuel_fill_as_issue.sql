-- A generator fuel fill is one stock issue and one cost event, not an internal transfer.
-- The destination tank remains a diagnostic/event association; no second on-hand
-- quantity is created there because periodic tank readings are not required.
ALTER TABLE public.generator_fuel_events
  ALTER COLUMN stock_transfer_id DROP NOT NULL,
  ALTER COLUMN destination_movement_id DROP NOT NULL;

create or replace function public.powerhub_inventory_record_fuel_fill(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_generator_id bigint,
  p_fuel_item_id bigint,
  p_source_warehouse_id bigint,
  p_destination_warehouse_id bigint,
  p_litres numeric,
  p_occurred_at timestamptz,
  p_level_before_liters numeric,
  p_level_after_liters numeric,
  p_operating_hours numeric,
  p_reference_no text,
  p_notes text,
  p_operation_key text
)
returns table(fuel_event_id bigint,stock_transfer_id bigint,litres numeric,total_cost_amount numeric,replayed boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_generator public.generators%rowtype;
  v_source public.inventory_warehouses%rowtype;
  v_destination public.inventory_warehouses%rowtype;
  v_item public.inventory_items%rowtype;
  v_existing public.generator_fuel_events%rowtype;
  v_before_quantity numeric(14,3);
  v_before_value numeric(14,2);
  v_movement_key text;
  v_movement_payload_hash text;
  v_movement_id bigint;
  v_payload_hash text;
  v_unit_cost numeric(14,4);
  v_total_cost numeric(14,2);
  v_platform_role text;
  v_reference text:=nullif(trim(coalesce(p_reference_no,'')),'');
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_generator_id is null
    or p_fuel_item_id is null or p_source_warehouse_id is null or p_destination_warehouse_id is null
    or p_source_warehouse_id=p_destination_warehouse_id or p_litres is null or p_litres<=0 or p_litres>1000000000
    or abs(p_litres*1000-round(p_litres*1000))>0.0000001
    or p_occurred_at is null or p_occurred_at>now()+interval '5 minutes'
    or (p_level_before_liters is null)<>(p_level_after_liters is null)
    or (p_level_before_liters is not null and (p_level_before_liters<0 or p_level_before_liters>1000000000 or p_level_after_liters<p_level_before_liters or p_level_after_liters>1000000000))
    or (p_operating_hours is not null and (p_operating_hours<0 or abs(p_operating_hours*1000-round(p_operating_hours*1000))>0.0000001))
    or p_operation_key is null or length(trim(p_operation_key)) not between 1 and 150 then
    raise exception 'INVALID_FUEL_FILL' using errcode='P0001';
  end if;
  if v_reference is not null and length(v_reference)>120 then raise exception 'INVALID_FUEL_FILL_REFERENCE' using errcode='P0001'; end if;
  if v_notes is not null and length(v_notes)>2000 then raise exception 'INVALID_FUEL_FILL_NOTES' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':fuel-fill:'||trim(p_operation_key),0));
  v_payload_hash:=md5(jsonb_build_object(
    'siteId',p_site_id,'generatorId',p_generator_id,'fuelItemId',p_fuel_item_id,
    'sourceWarehouseId',p_source_warehouse_id,'destinationWarehouseId',p_destination_warehouse_id,
    'litres',p_litres,'occurredAt',p_occurred_at,'levelBeforeLiters',p_level_before_liters,
    'levelAfterLiters',p_level_after_liters,'operatingHours',p_operating_hours,
    'referenceNo',v_reference,'notes',v_notes
  )::text);
  select e.* into v_existing from public.generator_fuel_events e
    where e.tenant_id=p_tenant_id and e.operation_key=trim(p_operation_key);
  if found then
    if v_existing.operation_payload_hash is distinct from v_payload_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    return query select v_existing.id,v_existing.stock_transfer_id,v_existing.litres,v_existing.total_cost_amount,true;
    return;
  end if;

  select g.* into v_generator from public.generators g
    where g.tenant_id=p_tenant_id and g.site_id=p_site_id and g.id=p_generator_id for update;
  if not found then raise exception 'FUEL_GENERATOR_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select w.* into v_source from public.inventory_warehouses w
    where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_source_warehouse_id and w.is_active;
  if not found or v_source.location_type not in ('central_warehouse','branch_warehouse','fixed_fuel_tank') then
    raise exception 'FUEL_SOURCE_LOCATION_INVALID' using errcode='P0001';
  end if;
  select w.* into v_destination from public.inventory_warehouses w
    where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_destination_warehouse_id and w.is_active;
  if not found or v_destination.location_type<>'generator_fuel_tank' or v_destination.generator_id<>p_generator_id then
    raise exception 'FUEL_DESTINATION_TANK_INVALID' using errcode='P0001';
  end if;
  select i.* into v_item from public.inventory_items i
    where i.tenant_id=p_tenant_id and i.id=p_fuel_item_id and i.is_active;
  if not found or v_item.category<>'fuel' or lower(v_item.base_unit) not in ('liter','litre') then
    raise exception 'FUEL_ITEM_MUST_BE_LITRES' using errcode='P0001';
  end if;


  v_movement_key:='fuel-fill:'||trim(p_operation_key)||':issue';
  -- Serialize with every other stock mutation for this source warehouse/item.
  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':inventory-stock:'||p_source_warehouse_id::text||':'||p_fuel_item_id::text,0
  ));

  select
    coalesce(sum(case
      when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.quantity else -m.quantity end),0)::numeric(14,3),
    coalesce(sum(case
      when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.total_cost_amount else -m.total_cost_amount end),0)::numeric(14,2)
  into v_before_quantity,v_before_value
  from public.inventory_stock_movements m
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id
    and m.warehouse_id=p_source_warehouse_id and m.item_id=p_fuel_item_id;

  if v_before_quantity< p_litres then
    raise exception 'INSUFFICIENT_STOCK' using errcode='P0001';
  end if;
  if v_before_quantity<=0 or v_before_value<0 then
    raise exception 'INVENTORY_BALANCE_INVALID' using errcode='P0001';
  end if;

  -- Match the inventory ledger's moving-average issue valuation, including exact
  -- remaining value when this fill consumes the source warehouse's last litres.
  if p_litres=v_before_quantity then
    v_total_cost:=greatest(v_before_value,0)::numeric(14,2);
  else
    v_total_cost:=round(p_litres*round(greatest(v_before_value,0)/v_before_quantity,4),2);
  end if;
  v_unit_cost:=case when p_litres>0 then round(v_total_cost/p_litres,4) else 0 end;

  v_movement_payload_hash:=md5(jsonb_build_object(
    'tenantId',p_tenant_id,'siteId',p_site_id,'warehouseId',p_source_warehouse_id,
    'itemId',p_fuel_item_id,'movementType','fuel_consumption','quantity',p_litres,
    'unitCost',v_unit_cost,'totalCostAmount',v_total_cost,'generatorId',p_generator_id,
    'occurredAt',p_occurred_at,'referenceNo',v_reference,'notes',v_notes,
    'fuelEventOperationKey',trim(p_operation_key)
  )::text);

  insert into public.inventory_stock_movements(
    tenant_id,site_id,warehouse_id,item_id,generator_id,movement_type,quantity,unit_cost,total_cost_amount,
    reference_no,notes,operation_key,operation_payload_hash,occurred_at,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_source_warehouse_id,p_fuel_item_id,p_generator_id,'fuel_consumption',
    p_litres,v_unit_cost,v_total_cost,v_reference,
    concat_ws(' — ','وقود مصروف للمولد حسب سجل التعبئة',v_notes),
    v_movement_key,v_movement_payload_hash,p_occurred_at,p_user_id
  ) returning id into v_movement_id;

  insert into public.generator_fuel_events(
    tenant_id,site_id,generator_id,fuel_item_id,source_warehouse_id,destination_warehouse_id,
    stock_transfer_id,source_movement_id,destination_movement_id,litres,unit_cost,total_cost_amount,
    occurred_at,level_before_liters,level_after_liters,operating_hours,reference_no,notes,
    operation_key,operation_payload_hash,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_generator_id,p_fuel_item_id,p_source_warehouse_id,p_destination_warehouse_id,
    null,v_movement_id,null,p_litres,
    v_unit_cost,v_total_cost,p_occurred_at,p_level_before_liters,p_level_after_liters,p_operating_hours,
    v_reference,v_notes,trim(p_operation_key),v_payload_hash,p_user_id
  ) returning * into v_existing;

  if p_level_before_liters is not null then
    perform * from public.powerhub_inventory_record_fuel_reading(
      p_tenant_id,p_site_id,p_user_id,p_generator_id,'tank_level',p_destination_warehouse_id,
      p_level_before_liters,p_occurred_at,v_reference,'مستوى الخزان قبل التعبئة: '||coalesce(v_notes,''),
      null,null,trim(p_operation_key)||':level-before'
    );
    perform * from public.powerhub_inventory_record_fuel_reading(
      p_tenant_id,p_site_id,p_user_id,p_generator_id,'tank_level',p_destination_warehouse_id,
      p_level_after_liters,p_occurred_at,v_reference,'مستوى الخزان بعد التعبئة: '||coalesce(v_notes,''),
      null,null,trim(p_operation_key)||':level-after'
    );
  end if;
  if p_operating_hours is not null then
    perform * from public.powerhub_inventory_record_fuel_reading(
      p_tenant_id,p_site_id,p_user_id,p_generator_id,'operating_hours',null,
      p_operating_hours,p_occurred_at,v_reference,'قراءة ساعات التشغيل عند التعبئة: '||coalesce(v_notes,''),
      null,null,trim(p_operation_key)||':operating-hours'
    );
  end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if v_platform_role not in ('platform_owner','platform_admin','finance_admin') then v_platform_role:=null; end if;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata)
  values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'generator_fuel_event',v_existing.id::text,'create',
    jsonb_build_object('generatorId',p_generator_id,'fuelItemId',p_fuel_item_id,'sourceWarehouseId',p_source_warehouse_id,
      'destinationWarehouseId',p_destination_warehouse_id,'litres',p_litres,'unitCost',v_unit_cost,
      'totalCostAmount',v_total_cost,'occurredAt',p_occurred_at,'levelBeforeLiters',p_level_before_liters,
      'levelAfterLiters',p_level_after_liters,'operatingHours',p_operating_hours,
      'stockMovementId',v_movement_id,'stockTransferId',null),
    jsonb_build_object('operationKey',trim(p_operation_key),'referenceNo',v_reference)
  );

  return query select v_existing.id,v_existing.stock_transfer_id,v_existing.litres,v_existing.total_cost_amount,false;
end;
$function$;

COMMENT ON FUNCTION public.powerhub_inventory_record_fuel_fill(
  bigint,bigint,bigint,bigint,bigint,bigint,bigint,numeric,timestamptz,numeric,numeric,numeric,text,text,text
) IS
  'Records a generator fuel fill as one idempotent fuel_consumption issue from the source warehouse at moving-average cost. The destination generator tank is retained as an operational reference only; tank-level and operating-hour readings are optional diagnostics.';

NOTIFY pgrst, 'reload schema';
