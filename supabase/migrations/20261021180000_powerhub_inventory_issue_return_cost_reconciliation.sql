-- Batch three: preserve moving-average valuation on final depletion and safely return issued stock.
alter table public.inventory_stock_movements
  add column if not exists source_issue_movement_id bigint;

do $return_source_fk$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.inventory_stock_movements'::regclass and conname='inventory_stock_movements_source_issue_tenant_fk') then
    alter table public.inventory_stock_movements add constraint inventory_stock_movements_source_issue_tenant_fk
      foreign key (tenant_id,source_issue_movement_id)
      references public.inventory_stock_movements(tenant_id,id) on delete restrict;
  end if;
end;
$return_source_fk$;

create index if not exists inventory_stock_movements_source_issue_idx
  on public.inventory_stock_movements(tenant_id,source_issue_movement_id)
  where source_issue_movement_id is not null;

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
  v_movement_total_cost numeric(14,2);
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

  -- Moving-average issue valuation: if this movement empties stock, consume the exact
  -- remaining value instead of recalculating it from a rounded average unit cost.
  if p_movement_type in ('issue','adjustment_out','fuel_consumption') and p_quantity=v_before_quantity then
    v_movement_total_cost := greatest(v_before_value,0)::numeric(14,2);
    v_unit_cost := round(v_movement_total_cost/p_quantity,4);
  else
    v_movement_total_cost := round(p_quantity*v_unit_cost,2);
  end if;

  insert into public.inventory_stock_movements(
    tenant_id,site_id,warehouse_id,item_id,generator_id,movement_type,quantity,unit_cost,total_cost_amount,
    reference_no,notes,operation_key,operation_payload_hash,occurred_at,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_warehouse_id,p_item_id,p_generator_id,p_movement_type,p_quantity,v_unit_cost,v_movement_total_cost,
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



drop function if exists public.powerhub_inventory_list_stock_movements(bigint,bigint,integer);
create function public.powerhub_inventory_list_stock_movements(
  p_tenant_id bigint,p_site_id bigint,p_limit integer default 100
)
returns table(
  movement_id bigint,warehouse_id bigint,warehouse_code text,warehouse_name text,
  item_id bigint,sku text,item_name text,base_unit text,generator_id bigint,movement_type text,
  quantity numeric,unit_cost numeric,total_cost_amount numeric,reference_no text,notes text,
  operation_key text,occurred_at timestamptz,created_by_user_id bigint,created_at timestamptz,
  reversal_of_movement_id bigint,corrects_movement_id bigint,correction_reason text,
  corrected_by_movement_id bigint,can_edit boolean,source_issue_movement_id bigint,returnable_quantity numeric
)
language sql stable security invoker set search_path=public,pg_temp
as $$
  select m.id,w.id,w.code,w.name,i.id,i.sku,i.name,i.base_unit,m.generator_id,m.movement_type,
    m.quantity,m.unit_cost,m.total_cost_amount,m.reference_no,m.notes,m.operation_key,m.occurred_at,
    m.created_by_user_id,m.created_at,m.reversal_of_movement_id,m.corrects_movement_id,m.correction_reason,
    (select c.id from public.inventory_stock_movements c
      where c.tenant_id=m.tenant_id and c.reversal_of_movement_id=m.id order by c.id desc limit 1),
    (
      m.movement_type in ('issue','adjustment_in','adjustment_out','fuel_consumption')
      and m.purchase_id is null and m.purchase_line_id is null
      and m.reversal_of_movement_id is null and m.corrects_movement_id is null
      and not exists(select 1 from public.inventory_stock_movements c
        where c.tenant_id=m.tenant_id and c.reversal_of_movement_id=m.id)
      and not exists(select 1 from public.inventory_stock_movements later
        where later.tenant_id=m.tenant_id and later.site_id=m.site_id
          and later.warehouse_id=m.warehouse_id and later.item_id=m.item_id and later.id>m.id)
    ),
    m.source_issue_movement_id,
    case when m.movement_type='issue'
      and not exists(select 1 from public.inventory_stock_movements c
        where c.tenant_id=m.tenant_id and (c.reversal_of_movement_id=m.id or c.corrects_movement_id=m.id))
      then greatest(
        m.quantity-coalesce((select sum(r.quantity) from public.inventory_stock_movements r
          where r.tenant_id=m.tenant_id and r.source_issue_movement_id=m.id
            and r.movement_type='return_from_issue'),0),0
      ) else 0::numeric end
  from public.inventory_stock_movements m
  join public.inventory_items i on i.tenant_id=m.tenant_id and i.id=m.item_id
  join public.inventory_warehouses w on w.tenant_id=m.tenant_id and w.site_id=m.site_id and w.id=m.warehouse_id
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id
  order by m.occurred_at desc,m.id desc limit greatest(1,least(coalesce(p_limit,100),500));
$$;



revoke all on function public.powerhub_inventory_list_stock_movements(bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_list_stock_movements(bigint,bigint,integer) to service_role;

create or replace function public.powerhub_inventory_return_from_issue(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_source_issue_movement_id bigint,
  p_quantity numeric,
  p_reason text,
  p_reference_no text,
  p_notes text,
  p_operation_key text
)
returns table(
  return_movement_id bigint,source_issue_movement_id bigint,quantity numeric,
  unit_cost numeric,total_cost_amount numeric,on_hand_quantity numeric,stock_value numeric,replayed boolean
)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_source public.inventory_stock_movements%rowtype;
  v_existing public.inventory_stock_movements%rowtype;
  v_return public.inventory_stock_movements%rowtype;
  v_platform_role text;
  v_reason text:=nullif(btrim(p_reason),'');
  v_reference_no text:=nullif(btrim(p_reference_no),'');
  v_notes text:=nullif(btrim(p_notes),'');
  v_operation_key text:=nullif(btrim(p_operation_key),'');
  v_payload_hash text;
  v_returned_quantity numeric(14,3);
  v_returned_cost numeric(14,2);
  v_return_total_cost numeric(14,2);
  v_cumulative_cost numeric(14,2);
  v_before_quantity numeric(14,3);
  v_before_value numeric(14,2);
  v_after_quantity numeric(14,3);
  v_after_value numeric(14,2);
  v_unit_cost numeric(14,4);
begin
  if v_operation_key is null or length(v_operation_key)>180 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if p_source_issue_movement_id is null or p_source_issue_movement_id<=0 then
    raise exception 'STOCK_MOVEMENT_NOT_FOUND' using errcode='P0001';
  end if;
  if p_quantity is null or p_quantity<=0 or p_quantity>1000000000 or p_quantity*1000<>trunc(p_quantity*1000) then
    raise exception 'INVALID_STOCK_QUANTITY' using errcode='P0001';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'RETURN_FROM_ISSUE_REASON_REQUIRED' using errcode='P0001';
  end if;
  if p_reference_no is not null and length(p_reference_no)>120 then
    raise exception 'INVALID_STOCK_REFERENCE' using errcode='P0001';
  end if;
  if p_notes is not null and length(p_notes)>2000 then
    raise exception 'INVALID_STOCK_NOTES' using errcode='P0001';
  end if;
  v_payload_hash:=md5(jsonb_build_object(
    'site_id',p_site_id,'source_issue_movement_id',p_source_issue_movement_id,
    'quantity',round(p_quantity,3),'reason',v_reason,'reference_no',v_reference_no,'notes',v_notes
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':return-from-issue:'||v_operation_key,0));
  select m.* into v_existing from public.inventory_stock_movements m
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.operation_key=v_operation_key
  for update;
  if found then
    if v_existing.operation_payload_hash is distinct from v_payload_hash
      or v_existing.movement_type<>'return_from_issue'
      or v_existing.source_issue_movement_id is distinct from p_source_issue_movement_id then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    select coalesce(sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
      then m.quantity else -m.quantity end),0)::numeric(14,3),
      coalesce(sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
      then m.total_cost_amount else -m.total_cost_amount end),0)::numeric(14,2)
    into v_after_quantity,v_after_value from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id
      and m.warehouse_id=v_existing.warehouse_id and m.item_id=v_existing.item_id;
    return query select v_existing.id,v_existing.source_issue_movement_id,v_existing.quantity,
      v_existing.unit_cost,v_existing.total_cost_amount,v_after_quantity,greatest(v_after_value,0)::numeric(14,2),true;
    return;
  end if;

  select m.* into v_source from public.inventory_stock_movements m
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.id=p_source_issue_movement_id
  for update;
  if not found or v_source.movement_type<>'issue' or v_source.purchase_id is not null
    or v_source.purchase_line_id is not null or v_source.reversal_of_movement_id is not null then
    raise exception 'STOCK_MOVEMENT_NOT_RETURNABLE' using errcode='P0001';
  end if;
  if v_source.quantity<=0 or v_source.total_cost_amount<0
    or exists(select 1 from public.inventory_stock_movements c
      where c.tenant_id=p_tenant_id and c.reversal_of_movement_id=v_source.id)
    or exists(select 1 from public.inventory_stock_movements c
      where c.tenant_id=p_tenant_id and c.corrects_movement_id=v_source.id) then
    raise exception 'STOCK_MOVEMENT_NOT_RETURNABLE' using errcode='P0001';
  end if;
  if not exists(select 1 from public.inventory_warehouses w
    where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=v_source.warehouse_id and w.is_active=true) then
    raise exception 'STOCK_WAREHOUSE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if not exists(select 1 from public.inventory_items i
    where i.tenant_id=p_tenant_id and i.id=v_source.item_id and i.is_active=true) then
    raise exception 'STOCK_ITEM_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':inventory-stock:'||v_source.warehouse_id::text||':'||v_source.item_id::text,0
  ));

  if exists(select 1 from public.financial_settlements fs
    where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
      and ((fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_source.occurred_at::date and fs.period_end::date>=v_source.occurred_at::date))) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  select coalesce(sum(r.quantity),0)::numeric(14,3),coalesce(sum(r.total_cost_amount),0)::numeric(14,2)
    into v_returned_quantity,v_returned_cost
  from public.inventory_stock_movements r
  where r.tenant_id=p_tenant_id and r.site_id=p_site_id
    and r.source_issue_movement_id=v_source.id and r.movement_type='return_from_issue';
  if p_quantity>v_source.quantity-v_returned_quantity then
    raise exception 'RETURN_FROM_ISSUE_EXCEEDS_UNRETURNED_QUANTITY' using errcode='P0001';
  end if;

  v_cumulative_cost:=round(v_source.total_cost_amount*(v_returned_quantity+p_quantity)/v_source.quantity,2);
  v_return_total_cost:=v_cumulative_cost-v_returned_cost;
  if v_return_total_cost<0 then raise exception 'RETURN_FROM_ISSUE_COST_RECONCILIATION_FAILED' using errcode='P0001'; end if;
  v_unit_cost:=round(v_return_total_cost/p_quantity,4);

  select coalesce(sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
      then m.quantity else -m.quantity end),0)::numeric(14,3),
    coalesce(sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
      then m.total_cost_amount else -m.total_cost_amount end),0)::numeric(14,2)
  into v_before_quantity,v_before_value
  from public.inventory_stock_movements m
  where m.tenant_id=p_tenant_id and m.site_id=p_site_id
    and m.warehouse_id=v_source.warehouse_id and m.item_id=v_source.item_id;
  if v_before_quantity<0 or v_before_value<0 then
    raise exception 'INVENTORY_BALANCE_INVALID' using errcode='P0001';
  end if;
  v_after_quantity:=v_before_quantity+p_quantity;
  v_after_value:=v_before_value+v_return_total_cost;

  insert into public.inventory_stock_movements(
    tenant_id,site_id,warehouse_id,item_id,movement_type,quantity,unit_cost,total_cost_amount,
    source_issue_movement_id,reference_no,notes,operation_key,operation_payload_hash,occurred_at,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,v_source.warehouse_id,v_source.item_id,'return_from_issue',p_quantity,
    v_unit_cost,v_return_total_cost,v_source.id,v_reference_no,
    concat_ws(' — ',v_reason,v_notes),v_operation_key,v_payload_hash,now(),p_user_id
  ) returning * into v_return;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stock_movement',v_return.id::text,'return_from_issue',
    jsonb_build_object('sourceIssueMovementId',v_source.id,'issuedQuantity',v_source.quantity,'issuedCost',v_source.total_cost_amount,
      'previouslyReturnedQuantity',v_returned_quantity,'previouslyReturnedCost',v_returned_cost),
    jsonb_build_object('returnMovementId',v_return.id,'quantity',v_return.quantity,'totalCostAmount',v_return.total_cost_amount,
      'onHandQuantity',v_after_quantity,'stockValue',v_after_value),
    jsonb_build_object('operationKey',v_operation_key,'reason',v_reason,'sourceIssueMovementId',v_source.id)
  );

  return query select v_return.id,v_source.id,v_return.quantity,v_return.unit_cost,v_return.total_cost_amount,
    v_after_quantity,v_after_value,false;
end;
$$;


revoke all on function public.powerhub_inventory_return_from_issue(bigint,bigint,bigint,bigint,numeric,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.powerhub_inventory_return_from_issue(bigint,bigint,bigint,bigint,numeric,text,text,text,text)
  to service_role;
