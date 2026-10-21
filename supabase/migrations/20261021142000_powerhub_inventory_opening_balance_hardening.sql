-- Harden inventory opening balances: one initial ledger entry per warehouse/item,
-- explicit opening unit cost, and reason/audit via the existing atomic movement RPC.

create or replace function public.powerhub_inventory_record_stock_movement(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_warehouse_id bigint,
  p_item_id bigint,
  p_movement_type text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_generator_id bigint,
  p_reference_no text,
  p_notes text,
  p_operation_key text
)
returns table(
  movement_id bigint,
  movement_type text,
  quantity numeric,
  unit_cost numeric,
  total_cost_amount numeric,
  operation_key text,
  replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_existing public.inventory_stock_movements%rowtype;
  v_movement public.inventory_stock_movements%rowtype;
  v_item public.inventory_items%rowtype;
  v_warehouse public.inventory_warehouses%rowtype;
  v_platform_role text;
  v_payload_hash text;
  v_before_quantity numeric(14,3);
  v_before_value numeric(14,2);
  v_after_quantity numeric(14,3);
  v_unit_cost numeric(14,4);
begin
  if p_operation_key is null or length(btrim(p_operation_key)) not between 1 and 180 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if p_movement_type not in ('issue','opening_balance','adjustment_in','adjustment_out','fuel_consumption') then
    raise exception 'INVALID_STOCK_MOVEMENT' using errcode='P0001';
  end if;
  if p_quantity is null or p_quantity<=0 or p_quantity>1000000000
    or p_quantity*1000<>trunc(p_quantity*1000) then
    raise exception 'INVALID_STOCK_QUANTITY' using errcode='P0001';
  end if;
  if p_unit_cost is not null and (
    p_unit_cost<0 or p_unit_cost>1000000000 or p_unit_cost*10000<>trunc(p_unit_cost*10000)
  ) then
    raise exception 'INVALID_STOCK_UNIT_COST' using errcode='P0001';
  end if;
  if p_movement_type not in ('adjustment_in','opening_balance') and p_unit_cost is not null then
    raise exception 'INVALID_STOCK_UNIT_COST' using errcode='P0001';
  end if;
  if p_movement_type in ('opening_balance','adjustment_in','adjustment_out')
    and nullif(btrim(coalesce(p_notes,'')),'') is null then
    raise exception 'STOCK_ADJUSTMENT_REASON_REQUIRED' using errcode='P0001';
  end if;
  if p_movement_type='fuel_consumption' and p_generator_id is null then
    raise exception 'GENERATOR_REQUIRED' using errcode='P0001';
  end if;

  v_payload_hash := md5(jsonb_build_object(
    'tenant_id',p_tenant_id,
    'site_id',p_site_id,
    'warehouse_id',p_warehouse_id,
    'item_id',p_item_id,
    'movement_type',p_movement_type,
    'quantity',p_quantity,
    'unit_cost',p_unit_cost,
    'generator_id',p_generator_id,
    'reference_no',nullif(btrim(p_reference_no),''),
    'notes',nullif(btrim(p_notes),'')
  )::text);

  -- Serialize duplicate request keys before checking the existing ledger row.
  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':inventory-stock-operation:'||btrim(p_operation_key),0
  ));
  select m.* into v_existing
  from public.inventory_stock_movements as m
  where m.tenant_id=p_tenant_id and m.operation_key=btrim(p_operation_key)
  for update;

  if found then
    if v_existing.operation_payload_hash is distinct from v_payload_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    return query select
      v_existing.id,v_existing.movement_type,v_existing.quantity,v_existing.unit_cost,
      v_existing.total_cost_amount,v_existing.operation_key,true;
    return;
  end if;

  perform 1 from public.sites as s where s.id=p_site_id and s.tenant_id=p_tenant_id;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select w.* into v_warehouse
  from public.inventory_warehouses as w
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id
    and w.id=p_warehouse_id and w.is_active=true;
  if not found then raise exception 'STOCK_WAREHOUSE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select i.* into v_item
  from public.inventory_items as i
  where i.tenant_id=p_tenant_id and i.id=p_item_id and i.is_active=true;
  if not found then raise exception 'STOCK_ITEM_OUT_OF_SCOPE' using errcode='P0001'; end if;

  if p_generator_id is not null and not exists (
    select 1 from public.generators as g
    where g.id=p_generator_id and g.tenant_id=p_tenant_id and g.site_id=p_site_id
  ) then
    raise exception 'STOCK_GENERATOR_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_movement_type='fuel_consumption' and v_item.category<>'fuel' then
    raise exception 'FUEL_ITEM_REQUIRED' using errcode='P0001';
  end if;

  select u.platform_role into v_platform_role
  from public.users as u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  -- Inventory valuation affects the locked close, so do not mutate it during a locked period.
  if exists (
    select 1 from public.financial_settlements as fs
    where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
      and fs.period_start<=now() and fs.period_end>=now()
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  -- A per-warehouse/item lock prevents two concurrent issues from overspending stock.
  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':inventory-stock:'||p_warehouse_id::text||':'||p_item_id::text,0
  ));

  if p_movement_type='opening_balance' and exists (
    select 1 from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id
      and m.warehouse_id=p_warehouse_id and m.item_id=p_item_id
  ) then
    raise exception 'OPENING_BALANCE_ALREADY_EXISTS' using errcode='P0001';
  end if;

  select
    coalesce(sum(case
      when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.quantity
      else -m.quantity
    end),0)::numeric(14,3),
    coalesce(sum(case
      when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.total_cost_amount
      else -m.total_cost_amount
    end),0)::numeric(14,2)
  into v_before_quantity,v_before_value
  from public.inventory_stock_movements as m
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id
    and m.warehouse_id=p_warehouse_id and m.item_id=p_item_id;

  if p_movement_type in ('issue','adjustment_out','fuel_consumption')
    and p_quantity>v_before_quantity then
    raise exception 'INSUFFICIENT_STOCK' using errcode='P0001';
  end if;

  if p_movement_type in ('opening_balance','adjustment_in') then
    if p_unit_cost is null and v_before_quantity<=0 then
      raise exception 'STOCK_UNIT_COST_REQUIRED' using errcode='P0001';
    end if;
    v_unit_cost := coalesce(
      round(p_unit_cost,4),
      case when v_before_quantity>0
        then round(greatest(v_before_value,0)/v_before_quantity,4)
        else 0::numeric
      end
    );
  else
    v_unit_cost := case when v_before_quantity>0
      then round(greatest(v_before_value,0)/v_before_quantity,4)
      else 0::numeric
    end;
  end if;

  v_after_quantity := v_before_quantity + case
    when p_movement_type in ('opening_balance','adjustment_in') then p_quantity
    else -p_quantity
  end;

  insert into public.inventory_stock_movements(
    tenant_id,site_id,warehouse_id,item_id,generator_id,movement_type,quantity,unit_cost,
    reference_no,notes,operation_key,operation_payload_hash,occurred_at,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_warehouse_id,p_item_id,p_generator_id,p_movement_type,p_quantity,v_unit_cost,
    nullif(btrim(p_reference_no),''),nullif(btrim(p_notes),''),btrim(p_operation_key),v_payload_hash,now(),p_user_id
  ) returning * into v_movement;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stock_movement',
    v_movement.id::text,p_movement_type,
    jsonb_build_object('onHandQuantity',v_before_quantity,'stockValue',v_before_value),
    jsonb_build_object(
      'movementType',v_movement.movement_type,'itemId',v_item.id,'itemName',v_item.name,
      'warehouseId',v_warehouse.id,'quantity',v_movement.quantity,'unitCost',v_movement.unit_cost,
      'totalCostAmount',v_movement.total_cost_amount,'generatorId',v_movement.generator_id,
      'onHandQuantity',v_after_quantity,'referenceNo',v_movement.reference_no
    ),
    jsonb_build_object('operationKey',v_movement.operation_key,'payloadHash',v_payload_hash)
  );

  return query select
    v_movement.id,v_movement.movement_type,v_movement.quantity,v_movement.unit_cost,
    v_movement.total_cost_amount,v_movement.operation_key,false;
end;
$$;

revoke all on function public.powerhub_inventory_record_stock_movement(bigint,bigint,bigint,bigint,bigint,text,numeric,numeric,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_record_stock_movement(bigint,bigint,bigint,bigint,bigint,text,numeric,numeric,bigint,text,text,text) to service_role;
