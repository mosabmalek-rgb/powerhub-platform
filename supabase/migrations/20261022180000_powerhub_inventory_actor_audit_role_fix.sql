-- Keep audit_logs.actor_platform_role reserved for actual platform roles.
-- Tenant users have no platform role; store NULL rather than the invalid synthetic
-- value 'tenant_user', which violates audit_logs_actor_platform_role_check.
-- Recreate only functions affected by the original fallback; grants remain unchanged.

create or replace function public.powerhub_inventory_create_warehouse_with_location(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_code text,
  p_name text,
  p_notes text,
  p_location_type text,
  p_generator_id bigint default null
)
returns table(
  id bigint,tenant_id bigint,site_id bigint,code text,name text,notes text,
  is_active boolean,location_type text,generator_id bigint,created_at timestamptz,updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_warehouse public.inventory_warehouses%rowtype;
  v_platform_role text;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_code is null or length(btrim(p_code)) not between 1 and 40
    or p_name is null or length(btrim(p_name)) not between 1 and 120 then
    raise exception 'INVALID_INVENTORY_WAREHOUSE' using errcode='P0001';
  end if;
  if p_location_type not in ('central_warehouse','branch_warehouse','fixed_fuel_tank','generator_fuel_tank')
    or p_location_type is null
    or ((p_location_type='generator_fuel_tank')<>(p_generator_id is not null)) then
    raise exception 'INVALID_INVENTORY_LOCATION_TYPE' using errcode='P0001';
  end if;
  if p_generator_id is not null and not exists(
    select 1 from public.generators g
    where g.tenant_id=p_tenant_id and g.site_id=p_site_id and g.id=p_generator_id
  ) then raise exception 'STOCK_GENERATOR_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role
  from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.inventory_warehouses(
    tenant_id,site_id,code,name,notes,location_type,generator_id,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,btrim(p_code),btrim(p_name),nullif(btrim(p_notes),''),
    p_location_type,p_generator_id,p_user_id
  ) returning * into v_warehouse;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_warehouse',v_warehouse.id::text,'create',
    jsonb_build_object('code',v_warehouse.code,'name',v_warehouse.name,
      'locationType',v_warehouse.location_type,'generatorId',v_warehouse.generator_id)
  );
  return query select v_warehouse.id,v_warehouse.tenant_id,v_warehouse.site_id,v_warehouse.code,
    v_warehouse.name,v_warehouse.notes,v_warehouse.is_active,v_warehouse.location_type,
    v_warehouse.generator_id,v_warehouse.created_at,v_warehouse.updated_at;
end;
$$;

create or replace function public.powerhub_inventory_update_warehouse_with_location(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_warehouse_id bigint,
  p_code text,
  p_name text,
  p_notes text,
  p_location_type text,
  p_generator_id bigint default null
)
returns table(
  id bigint,tenant_id bigint,site_id bigint,code text,name text,notes text,
  is_active boolean,location_type text,generator_id bigint,created_at timestamptz,updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_warehouse public.inventory_warehouses%rowtype;
  v_before jsonb;
  v_platform_role text;
  v_code text:=btrim(coalesce(p_code,''));
  v_name text:=btrim(coalesce(p_name,''));
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if length(v_code) not between 1 and 40 or length(v_name) not between 1 and 120 then
    raise exception 'INVALID_INVENTORY_WAREHOUSE' using errcode='P0001';
  end if;
  if p_location_type not in ('central_warehouse','branch_warehouse','fixed_fuel_tank','generator_fuel_tank')
    or p_location_type is null
    or ((p_location_type='generator_fuel_tank')<>(p_generator_id is not null)) then
    raise exception 'INVALID_INVENTORY_LOCATION_TYPE' using errcode='P0001';
  end if;
  if p_generator_id is not null and not exists(
    select 1 from public.generators g
    where g.tenant_id=p_tenant_id and g.site_id=p_site_id and g.id=p_generator_id
  ) then raise exception 'STOCK_GENERATOR_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select w.* into v_warehouse from public.inventory_warehouses w
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_warehouse_id
  for update;
  if not found then raise exception 'STOCK_WAREHOUSE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  if (v_code is distinct from v_warehouse.code
      or v_name is distinct from v_warehouse.name
      or p_location_type is distinct from v_warehouse.location_type
      or p_generator_id is distinct from v_warehouse.generator_id)
    and (
      exists(select 1 from public.inventory_stock_movements m
        where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.warehouse_id=p_warehouse_id)
      or exists(select 1 from public.supplier_purchases p
        where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.warehouse_id=p_warehouse_id)
      or exists(select 1 from public.inventory_stock_transfers t
        where t.tenant_id=p_tenant_id and t.site_id=p_site_id
          and (t.source_warehouse_id=p_warehouse_id or t.destination_warehouse_id=p_warehouse_id))
    ) then
    raise exception 'WAREHOUSE_IDENTITY_IMMUTABLE_AFTER_USE' using errcode='P0001';
  end if;

  v_before:=jsonb_build_object('code',v_warehouse.code,'name',v_warehouse.name,'notes',v_warehouse.notes,
    'locationType',v_warehouse.location_type,'generatorId',v_warehouse.generator_id);
  select u.platform_role into v_platform_role
  from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  update public.inventory_warehouses w set
    code=v_code,name=v_name,notes=nullif(btrim(p_notes),''),
    location_type=p_location_type,generator_id=p_generator_id,updated_at=now()
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_warehouse_id
  returning * into v_warehouse;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_warehouse',v_warehouse.id::text,'update',v_before,
    jsonb_build_object('code',v_warehouse.code,'name',v_warehouse.name,'notes',v_warehouse.notes,
      'locationType',v_warehouse.location_type,'generatorId',v_warehouse.generator_id)
  );
  return query select v_warehouse.id,v_warehouse.tenant_id,v_warehouse.site_id,v_warehouse.code,
    v_warehouse.name,v_warehouse.notes,v_warehouse.is_active,v_warehouse.location_type,
    v_warehouse.generator_id,v_warehouse.created_at,v_warehouse.updated_at;
end;
$$;

create or replace function public.powerhub_inventory_create_stocktake(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_warehouse_id bigint,
  p_reason text,p_notes text,p_operation_key text
)
returns table(
  stocktake_id bigint,stocktake_number text,status text,warehouse_id bigint,
  snapshot_at timestamptz,item_count integer,replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_stocktake public.inventory_stocktakes%rowtype;
  v_warehouse public.inventory_warehouses%rowtype;
  v_platform_role text;
  v_reason text:=nullif(btrim(p_reason),'');
  v_notes text:=nullif(btrim(p_notes),'');
  v_operation_key text:=nullif(btrim(p_operation_key),'');
  v_payload_hash text;
  v_item_count integer;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_warehouse_id is null then
    raise exception 'STOCKTAKE_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'STOCKTAKE_REASON_REQUIRED' using errcode='P0001';
  end if;
  if v_operation_key is null or length(v_operation_key)>180 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if v_notes is not null and length(v_notes)>2000 then
    raise exception 'INVALID_STOCKTAKE_NOTES' using errcode='P0001';
  end if;
  if not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  v_payload_hash:=md5(jsonb_build_object(
    'siteId',p_site_id,'warehouseId',p_warehouse_id,'reason',v_reason,'notes',v_notes
  )::text);
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':stocktake:'||v_operation_key,0));

  select st.* into v_stocktake from public.inventory_stocktakes st
  where st.tenant_id=p_tenant_id and st.operation_key=v_operation_key for update;
  if found then
    if v_stocktake.operation_payload_hash is distinct from v_payload_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    select count(*)::integer into v_item_count from public.inventory_stocktake_lines l
    where l.tenant_id=p_tenant_id and l.stocktake_id=v_stocktake.id;
    return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,
      v_stocktake.warehouse_id,v_stocktake.snapshot_at,v_item_count,true;
    return;
  end if;

  select w.* into v_warehouse from public.inventory_warehouses w
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_warehouse_id
  for update;
  if not found then raise exception 'STOCK_WAREHOUSE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if not v_warehouse.is_active then raise exception 'STOCK_WAREHOUSE_INACTIVE' using errcode='P0001'; end if;

  if exists(
    select 1 from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.warehouse_id=p_warehouse_id
    group by m.item_id
    having sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
      then m.quantity else -m.quantity end)<0.000
      or sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.total_cost_amount else -m.total_cost_amount end)<-0.01
  ) then raise exception 'INVENTORY_BALANCE_INVALID' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role
  from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.inventory_stocktakes(
    tenant_id,site_id,warehouse_id,status,reason,notes,operation_key,operation_payload_hash,
    snapshot_at,created_by_user_id
  ) values(
    p_tenant_id,p_site_id,p_warehouse_id,'counting',v_reason,v_notes,v_operation_key,v_payload_hash,now(),p_user_id
  ) returning * into v_stocktake;

  update public.inventory_stocktakes st set
    stocktake_number='STK-'||p_site_id::text||'-'||lpad(v_stocktake.id::text,8,'0')
  where st.tenant_id=p_tenant_id and st.id=v_stocktake.id returning * into v_stocktake;

  with balances as(
    select m.item_id,
      sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.quantity else -m.quantity end)::numeric(14,3) as quantity,
      greatest(sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.total_cost_amount else -m.total_cost_amount end),0)::numeric(14,2) as value
    from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.warehouse_id=p_warehouse_id
    group by m.item_id
  )
  insert into public.inventory_stocktake_lines(
    tenant_id,stocktake_id,item_id,system_quantity,system_value,system_unit_cost
  )
  select p_tenant_id,v_stocktake.id,i.id,coalesce(b.quantity,0),coalesce(b.value,0),
    case when coalesce(b.quantity,0)>0 then round(coalesce(b.value,0)/b.quantity,4) else 0 end
  from public.inventory_items i
  left join balances b on b.item_id=i.id
  where i.tenant_id=p_tenant_id and i.is_active
    and (v_warehouse.location_type not in ('fixed_fuel_tank','generator_fuel_tank') or i.category='fuel');

  select count(*)::integer into v_item_count from public.inventory_stocktake_lines l
  where l.tenant_id=p_tenant_id and l.stocktake_id=v_stocktake.id;
  if v_item_count=0 then raise exception 'STOCKTAKE_CATALOG_EMPTY' using errcode='P0001'; end if;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data,metadata
  ) values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stocktake',v_stocktake.id::text,'create',
    jsonb_build_object('stocktakeNumber',v_stocktake.stocktake_number,'warehouseId',p_warehouse_id,
      'reason',v_reason,'itemCount',v_item_count,'snapshotAt',v_stocktake.snapshot_at),
    jsonb_build_object('operationKey',v_operation_key,'payloadHash',v_payload_hash)
  );

  return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,
    v_stocktake.warehouse_id,v_stocktake.snapshot_at,v_item_count,false;
end;
$$;

create or replace function public.powerhub_inventory_record_stocktake_count(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_stocktake_id bigint,p_item_id bigint,
  p_counted_quantity numeric,p_counted_unit_cost numeric,p_count_notes text
)
returns table(stocktake_id bigint,item_id bigint,system_quantity numeric,counted_quantity numeric,
  variance_quantity numeric,counted_at timestamptz,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_stocktake public.inventory_stocktakes%rowtype;
  v_line public.inventory_stocktake_lines%rowtype;
  v_platform_role text;
  v_before_counted_quantity numeric(14,3);
  v_before_counted_unit_cost numeric(14,4);
  v_notes text:=nullif(btrim(p_count_notes),'');
begin
  if not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_counted_quantity is null or p_counted_quantity<0 or p_counted_quantity>1000000000
    or abs(p_counted_quantity*1000-round(p_counted_quantity*1000))>0.0000001 then
    raise exception 'INVALID_STOCKTAKE_COUNT' using errcode='P0001';
  end if;
  if p_counted_unit_cost is not null and (p_counted_unit_cost<0 or p_counted_unit_cost>1000000000
    or abs(p_counted_unit_cost*10000-round(p_counted_unit_cost*10000))>0.0000001) then
    raise exception 'INVALID_STOCKTAKE_UNIT_COST' using errcode='P0001';
  end if;
  if v_notes is not null and length(v_notes)>500 then
    raise exception 'INVALID_STOCKTAKE_COUNT_NOTES' using errcode='P0001';
  end if;

  select st.* into v_stocktake from public.inventory_stocktakes st
  where st.tenant_id=p_tenant_id and st.site_id=p_site_id and st.id=p_stocktake_id for update;
  if not found then raise exception 'STOCKTAKE_NOT_FOUND' using errcode='P0001'; end if;
  if v_stocktake.status<>'counting' then raise exception 'STOCKTAKE_NOT_COUNTABLE' using errcode='P0001'; end if;
  select l.* into v_line from public.inventory_stocktake_lines l
  where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id and l.item_id=p_item_id for update;
  if not found then raise exception 'STOCKTAKE_ITEM_NOT_FOUND' using errcode='P0001'; end if;
  v_before_counted_quantity:=v_line.counted_quantity;
  v_before_counted_unit_cost:=v_line.counted_unit_cost;
  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  update public.inventory_stocktake_lines l set counted_quantity=p_counted_quantity,
    counted_unit_cost=p_counted_unit_cost,count_notes=v_notes,counted_by_user_id=p_user_id,
    counted_at=now(),updated_at=now()
  where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id and l.item_id=p_item_id
  returning * into v_line;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stocktake_line',v_line.id::text,'record_count',
    jsonb_build_object('countedQuantity',v_before_counted_quantity,'countedUnitCost',v_before_counted_unit_cost),
    jsonb_build_object('stocktakeId',p_stocktake_id,'itemId',p_item_id,'systemQuantity',v_line.system_quantity,
      'countedQuantity',v_line.counted_quantity,'varianceQuantity',v_line.variance_quantity,
      'countedUnitCost',v_line.counted_unit_cost,'notes',v_line.count_notes)
  );
  return query select v_line.stocktake_id,v_line.item_id,v_line.system_quantity,v_line.counted_quantity,
    v_line.variance_quantity,v_line.counted_at,false;
end;
$$;

create or replace function public.powerhub_inventory_submit_stocktake(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_stocktake_id bigint
)
returns table(stocktake_id bigint,stocktake_number text,status text,item_count integer,variance_count integer,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_stocktake public.inventory_stocktakes%rowtype;
  v_platform_role text;
  v_item_count integer;
  v_counted_count integer;
  v_variance_count integer;
begin
  select st.* into v_stocktake from public.inventory_stocktakes st
  where st.tenant_id=p_tenant_id and st.site_id=p_site_id and st.id=p_stocktake_id for update;
  if not found then raise exception 'STOCKTAKE_NOT_FOUND' using errcode='P0001'; end if;
  if v_stocktake.status='submitted' then
    select count(*)::integer,count(*) filter(where l.variance_quantity<>0)::integer
    into v_item_count,v_variance_count from public.inventory_stocktake_lines l
    where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id;
    return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,v_item_count,
      coalesce(v_variance_count,0),true;
    return;
  end if;
  if v_stocktake.status<>'counting' then raise exception 'STOCKTAKE_NOT_SUBMITTABLE' using errcode='P0001'; end if;

  select count(*)::integer,count(*) filter(where l.counted_quantity is not null)::integer,
    count(*) filter(where l.variance_quantity<>0)::integer
  into v_item_count,v_counted_count,v_variance_count
  from public.inventory_stocktake_lines l
  where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id;
  if v_item_count=0 or v_counted_count<>v_item_count then
    raise exception 'STOCKTAKE_COUNTS_INCOMPLETE' using errcode='P0001';
  end if;
  if not public.powerhub_inventory_stocktake_snapshot_is_current(p_tenant_id,p_site_id,p_stocktake_id) then
    raise exception 'STOCKTAKE_STOCK_CHANGED_DURING_COUNT' using errcode='P0001';
  end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  update public.inventory_stocktakes st set status='submitted',submitted_at=now(),submitted_by_user_id=p_user_id
  where st.tenant_id=p_tenant_id and st.id=p_stocktake_id returning * into v_stocktake;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stocktake',v_stocktake.id::text,'submit',
    jsonb_build_object('status','counting'),
    jsonb_build_object('status','submitted','itemCount',v_item_count,'varianceCount',coalesce(v_variance_count,0))
  );
  return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,v_item_count,
    coalesce(v_variance_count,0),false;
end;
$$;

create or replace function public.powerhub_inventory_post_stocktake(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_stocktake_id bigint
)
returns table(stocktake_id bigint,stocktake_number text,status text,item_count integer,
  variance_count integer,posted_movement_count integer,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_stocktake public.inventory_stocktakes%rowtype;
  v_warehouse public.inventory_warehouses%rowtype;
  v_line public.inventory_stocktake_lines%rowtype;
  v_platform_role text;
  v_lock_item_id bigint;
  v_variance numeric(14,3);
  v_unit_cost numeric(14,4);
  v_movement_id bigint;
  v_item_count integer;
  v_variance_count integer;
  v_posted_movement_count integer:=0;
begin
  select st.* into v_stocktake from public.inventory_stocktakes st
  where st.tenant_id=p_tenant_id and st.site_id=p_site_id and st.id=p_stocktake_id for update;
  if not found then raise exception 'STOCKTAKE_NOT_FOUND' using errcode='P0001'; end if;
  select count(*)::integer,count(*) filter(where l.variance_quantity<>0)::integer,
    count(*) filter(where l.posted_movement_id is not null)::integer
  into v_item_count,v_variance_count,v_posted_movement_count
  from public.inventory_stocktake_lines l where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id;
  if v_stocktake.status='posted' then
    return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,v_item_count,
      coalesce(v_variance_count,0),coalesce(v_posted_movement_count,0),true;
    return;
  end if;
  if v_stocktake.status<>'submitted' then raise exception 'STOCKTAKE_NOT_APPROVED' using errcode='P0001'; end if;

  -- Serialize with all stock mutations in the same warehouse before verifying the snapshot.
  -- Lock items deterministically so a receipt, issue, transfer, or return cannot slip
  -- between drift validation and the series of adjustment postings.
  select w.* into v_warehouse from public.inventory_warehouses w
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=v_stocktake.warehouse_id for update;
  if not found or not v_warehouse.is_active then raise exception 'STOCK_WAREHOUSE_INACTIVE' using errcode='P0001'; end if;

  for v_lock_item_id in
    select l.item_id from public.inventory_stocktake_lines l
    where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id
    order by l.item_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      p_tenant_id::text||':inventory-stock:'||v_stocktake.warehouse_id::text||':'||v_lock_item_id::text,0
    ));
  end loop;

  if not public.powerhub_inventory_stocktake_snapshot_is_current(p_tenant_id,p_site_id,p_stocktake_id) then
    raise exception 'STOCKTAKE_STOCK_CHANGED_DURING_COUNT' using errcode='P0001';
  end if;
  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  for v_line in
    select l.* from public.inventory_stocktake_lines l
    where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id and l.variance_quantity<>0
    order by l.item_id for update
  loop
    v_variance:=v_line.variance_quantity;
    if v_variance>0 then
      if v_line.system_quantity<=0 and v_line.counted_unit_cost is null then
        raise exception 'STOCKTAKE_SURPLUS_UNIT_COST_REQUIRED' using errcode='P0001';
      end if;
      v_unit_cost:=case when v_line.system_quantity>0 then v_line.system_unit_cost else v_line.counted_unit_cost end;
      select movement_id into v_movement_id from public.powerhub_inventory_record_stock_movement(
        p_tenant_id,p_site_id,p_user_id,v_stocktake.warehouse_id,v_line.item_id,'adjustment_in',
        v_variance,v_unit_cost,
        v_warehouse.generator_id,
        v_stocktake.stocktake_number,
        'ترحيل جرد فعلي: '||v_stocktake.reason||case when v_line.count_notes is not null then ' — '||v_line.count_notes else '' end,
        'stocktake:'||v_stocktake.id::text||':item:'||v_line.item_id::text
      );
    else
      select movement_id into v_movement_id from public.powerhub_inventory_record_stock_movement(
        p_tenant_id,p_site_id,p_user_id,v_stocktake.warehouse_id,v_line.item_id,'adjustment_out',
        abs(v_variance),null,
        v_warehouse.generator_id,
        v_stocktake.stocktake_number,
        'ترحيل جرد فعلي: '||v_stocktake.reason||case when v_line.count_notes is not null then ' — '||v_line.count_notes else '' end,
        'stocktake:'||v_stocktake.id::text||':item:'||v_line.item_id::text
      );
    end if;
    if v_movement_id is null then raise exception 'STOCKTAKE_POSTING_MOVEMENT_FAILED'; end if;
    update public.inventory_stocktake_lines l set posted_movement_id=v_movement_id,updated_at=now()
    where l.tenant_id=p_tenant_id and l.id=v_line.id;
    v_posted_movement_count:=v_posted_movement_count+1;
  end loop;

  update public.inventory_stocktakes st set status='posted',posted_at=now(),posted_by_user_id=p_user_id
  where st.tenant_id=p_tenant_id and st.id=p_stocktake_id returning * into v_stocktake;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stocktake',v_stocktake.id::text,'post',
    jsonb_build_object('status','submitted'),
    jsonb_build_object('status','posted','itemCount',v_item_count,'varianceCount',coalesce(v_variance_count,0),
      'postedMovementCount',v_posted_movement_count)
  );
  return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,v_item_count,
    coalesce(v_variance_count,0),v_posted_movement_count,false;
end;
$$;

create or replace function public.powerhub_inventory_cancel_stocktake(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_stocktake_id bigint,p_reason text
)
returns table(stocktake_id bigint,stocktake_number text,status text,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_stocktake public.inventory_stocktakes%rowtype;
  v_platform_role text;
  v_before_status text;
  v_reason text:=nullif(btrim(p_reason),'');
begin
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'STOCKTAKE_CANCEL_REASON_REQUIRED' using errcode='P0001';
  end if;
  select st.* into v_stocktake from public.inventory_stocktakes st
  where st.tenant_id=p_tenant_id and st.site_id=p_site_id and st.id=p_stocktake_id for update;
  if not found then raise exception 'STOCKTAKE_NOT_FOUND' using errcode='P0001'; end if;
  if v_stocktake.status='cancelled' then return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,true; return; end if;

  -- A submitted session may become stale while waiting for approval. Allow an audited
  -- cancellation in that state so it cannot block the warehouse forever. Once any
  -- adjustment is linked, it is no longer cancellable; posting itself is transactional.
  if v_stocktake.status not in ('counting','submitted')
    or exists(
      select 1 from public.inventory_stocktake_lines l
      where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id and l.posted_movement_id is not null
    ) then
    raise exception 'STOCKTAKE_NOT_CANCELLABLE' using errcode='P0001';
  end if;
  v_before_status:=v_stocktake.status;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  update public.inventory_stocktakes st set status='cancelled',cancelled_at=now(),cancelled_by_user_id=p_user_id,cancel_reason=v_reason
  where st.tenant_id=p_tenant_id and st.id=p_stocktake_id returning * into v_stocktake;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stocktake',v_stocktake.id::text,'cancel',
    jsonb_build_object('status',v_before_status),jsonb_build_object('status','cancelled','reason',v_reason)
  );
  return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,false;
end;
$$;

create or replace function public.powerhub_inventory_record_supplier_opening_balance(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_supplier_id bigint,
  p_amount numeric,
  p_as_of_date date,
  p_reference_no text,
  p_notes text
)
returns table(ledger_entry_id bigint,supplier_id bigint,amount numeric,as_of_date date,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_existing public.supplier_ledger_entries%rowtype;
  v_supplier public.suppliers%rowtype;
  v_entry public.supplier_ledger_entries%rowtype;
  v_actor_platform_role text;
  v_date date:=coalesce(p_as_of_date,current_date);
  v_reference text:=nullif(btrim(p_reference_no),'');
  v_notes text:=nullif(btrim(p_notes),'');
  v_entry_key text;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_supplier_id is null then
    raise exception 'SUPPLIER_OPENING_BALANCE_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if p_amount is null or p_amount<=0 or p_amount>1000000000 or p_amount<>round(p_amount,2) then
    raise exception 'INVALID_SUPPLIER_OPENING_BALANCE' using errcode='P0001';
  end if;
  if not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  v_entry_key:='supplier-opening-balance:'||p_site_id::text||':'||p_supplier_id::text;
  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':supplier-opening-balance:'||p_site_id::text||':'||p_supplier_id::text,0
  ));

  select s.* into v_supplier from public.suppliers s
  where s.tenant_id=p_tenant_id and s.id=p_supplier_id for update;
  if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if not v_supplier.is_active then raise exception 'SUPPLIER_INACTIVE' using errcode='P0001'; end if;

  select e.* into v_existing from public.supplier_ledger_entries e
  where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=p_supplier_id
    and e.entry_type='opening_balance' and e.purchase_id is null and e.supplier_payment_id is null
  order by e.id limit 1 for update;
  if found then
    if v_existing.entry_key=v_entry_key
      and v_existing.credit_amount=p_amount and v_existing.debit_amount=0
      and v_existing.occurred_at::date=v_date
      and coalesce(v_existing.reference_no,'')=coalesce(v_reference,'')
      and coalesce(v_existing.description,'')=(
        'رصيد افتتاحي مستحق للمورد: '||v_supplier.name||
        case when v_notes is not null then ' — '||v_notes else '' end
      ) then
      return query select v_existing.id,v_supplier.id,p_amount,v_date,true;
      return;
    end if;
    raise exception 'SUPPLIER_OPENING_BALANCE_ALREADY_EXISTS' using errcode='P0001';
  end if;

  if exists(
    select 1 from public.financial_settlements fs
    where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
      and ((fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_date and fs.period_end::date>=v_date))
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  select u.platform_role into v_actor_platform_role
  from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.supplier_ledger_entries(
    tenant_id,site_id,supplier_id,entry_type,debit_amount,credit_amount,purchase_id,supplier_payment_id,
    entry_key,reference_no,description,occurred_at,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_supplier_id,'opening_balance',0,p_amount,null,null,
    v_entry_key,v_reference,
    'رصيد افتتاحي مستحق للمورد: '||v_supplier.name||case when v_notes is not null then ' — '||v_notes else '' end,
    v_date::timestamp at time zone 'UTC',p_user_id
  ) returning * into v_entry;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,
    before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,'supplier_opening_balance',v_entry.id::text,'create',
    null,jsonb_build_object('supplierId',p_supplier_id,'amount',p_amount,'asOfDate',v_date,
      'referenceNo',v_reference,'notes',v_notes),
    jsonb_build_object('entryKey',v_entry_key,'direction','payable')
  );

  return query select v_entry.id,v_supplier.id,p_amount,v_date,false;
end;
$$;

create or replace function public.powerhub_inventory_record_supplier_payment_batch(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_supplier_id bigint,
  p_company_account_id bigint,
  p_amount numeric,
  p_payment_date date,
  p_reference_no text,
  p_notes text,
  p_operation_key text,
  p_allocations jsonb
)
returns table(
  payment_id bigint,
  supplier_id bigint,
  company_account_id bigint,
  account_transaction_id bigint,
  amount numeric,
  payment_date date,
  allocation_count integer,
  allocation_summary jsonb,
  account_balance numeric,
  replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_payment public.supplier_payments%rowtype;
  v_supplier public.suppliers%rowtype;
  v_purchase public.supplier_purchases%rowtype;
  v_opening public.supplier_ledger_entries%rowtype;
  v_account public.company_accounts%rowtype;
  v_actor_platform_role text;
  v_operation_key text:=nullif(btrim(p_operation_key),'');
  v_date date:=coalesce(p_payment_date,current_date);
  v_reference text:=nullif(btrim(p_reference_no),'');
  v_notes text:=nullif(btrim(p_notes),'');
  v_payload_hash text;
  v_canonical_allocations jsonb;
  v_summary jsonb;
  v_allocation record;
  v_invoice_ids bigint[]:='{}'::bigint[];
  v_account_balance numeric(14,2):=0;
  v_paid_before numeric(14,2);
  v_return_credit numeric(14,2);
  v_outstanding numeric(14,2);
  v_allocation_total numeric(14,2):=0;
  v_allocation_count integer:=0;
  v_distinct_count integer:=0;
  v_account_transaction_id bigint;
  v_invoice_summary text;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_supplier_id is null or p_company_account_id is null then
    raise exception 'SUPPLIER_PAYMENT_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if v_operation_key is null or length(v_operation_key)>180 then
    raise exception 'INVALID_OPERATION_KEY' using errcode='P0001';
  end if;
  if p_amount is null or p_amount<=0 or p_amount>1000000000 or p_amount<>round(p_amount,2) then
    raise exception 'INVALID_SUPPLIER_PAYMENT_AMOUNT' using errcode='P0001';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations)<>'array'
    or jsonb_array_length(p_allocations)<1 or jsonb_array_length(p_allocations)>100 then
    raise exception 'INVALID_SUPPLIER_PAYMENT_ALLOCATIONS' using errcode='P0001';
  end if;
  if exists(
    select 1 from jsonb_to_recordset(p_allocations) as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric)
    where (a.purchase_id is null)=(a.supplier_ledger_entry_id is null)
      or a.amount is null or a.amount<=0 or a.amount>1000000000 or a.amount<>round(a.amount,2)
      or coalesce(a.purchase_id,0)<0 or coalesce(a.supplier_ledger_entry_id,0)<0
  ) then
    raise exception 'INVALID_SUPPLIER_PAYMENT_ALLOCATIONS' using errcode='P0001';
  end if;

  select count(*)::integer,
    count(distinct case when a.purchase_id is not null then 'p:'||a.purchase_id::text else 'l:'||a.supplier_ledger_entry_id::text end)::integer,
    coalesce(sum(a.amount),0)::numeric(14,2),
    jsonb_agg(jsonb_build_object('purchase_id',a.purchase_id,'supplier_ledger_entry_id',a.supplier_ledger_entry_id,'amount',a.amount)
      order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0))
  into v_allocation_count,v_distinct_count,v_allocation_total,v_canonical_allocations
  from jsonb_to_recordset(p_allocations) as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric);
  if v_allocation_count<1 or v_allocation_count<>v_distinct_count then
    raise exception 'DUPLICATE_OR_INVALID_SUPPLIER_PAYMENT_ALLOCATION' using errcode='P0001';
  end if;
  if v_allocation_total<>p_amount then
    raise exception 'SUPPLIER_PAYMENT_ALLOCATION_TOTAL_MISMATCH' using errcode='P0001';
  end if;

  v_payload_hash:=md5(jsonb_build_object(
    'site_id',p_site_id,'supplier_id',p_supplier_id,'company_account_id',p_company_account_id,
    'amount',p_amount,'payment_date',v_date,'reference_no',v_reference,'notes',v_notes,
    'allocations',v_canonical_allocations
  )::text);

  perform pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text||':supplier-payment:'||v_operation_key,0
  ));

  select sp.* into v_payment from public.supplier_payments sp
  where sp.tenant_id=p_tenant_id and sp.operation_key=v_operation_key for update;
  if found then
    if v_payment.operation_payload_hash is distinct from v_payload_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    select ca.* into v_account from public.company_accounts ca
    where ca.tenant_id=p_tenant_id and ca.id=v_payment.company_account_id;
    if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
    select v_account.opening_balance+coalesce(sum(
      case when atx.transaction_type in ('deposit','transfer_in','collection') then atx.amount else -atx.amount end
    ),0)::numeric(14,2) into v_account_balance
    from public.account_transactions atx where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;
    select coalesce(jsonb_agg(jsonb_build_object(
      'purchase_id',a.purchase_id,'supplier_ledger_entry_id',a.supplier_ledger_entry_id,
      'document_reference',coalesce(p.purchase_number,e.reference_no,'رصيد افتتاحي'),'amount',a.amount
    ) order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0)),'[]'::jsonb)
    into v_summary
    from public.supplier_payment_allocations a
    left join public.supplier_purchases p on p.tenant_id=a.tenant_id and p.id=a.purchase_id
    left join public.supplier_ledger_entries e on e.tenant_id=a.tenant_id and e.id=a.supplier_ledger_entry_id
    where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id;
    return query select v_payment.id,v_payment.supplier_id,v_payment.company_account_id,
      v_payment.account_transaction_id,v_payment.amount,v_payment.payment_date,
      v_allocation_count,v_summary,v_account_balance,true;
    return;
  end if;

  if not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select s.* into v_supplier from public.suppliers s
  where s.tenant_id=p_tenant_id and s.id=p_supplier_id for update;
  if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if not v_supplier.is_active then raise exception 'SUPPLIER_INACTIVE' using errcode='P0001'; end if;

  -- Keep the canonical account -> documents lock order to serialize against other payments
  -- and stock-return workflows that share company-account balances.
  perform pg_advisory_xact_lock(p_company_account_id);
  select ca.* into v_account from public.company_accounts ca
  where ca.tenant_id=p_tenant_id and ca.id=p_company_account_id for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;
  if not v_account.is_active then raise exception 'COMPANY_ACCOUNT_INACTIVE' using errcode='P0001'; end if;
  if exists(select 1 from public.company_account_sites cas where cas.tenant_id=p_tenant_id and cas.account_id=v_account.id)
    and not exists(select 1 from public.company_account_sites cas where cas.tenant_id=p_tenant_id and cas.account_id=v_account.id and cas.site_id=p_site_id) then
    raise exception 'COMPANY_ACCOUNT_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if exists(
    select 1 from public.financial_settlements fs
    where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
      and ((fs.period_start<=now() and fs.period_end>=now())
        or (fs.period_start::date<=v_date and fs.period_end::date>=v_date))
  ) then
    raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001';
  end if;

  -- Lock invoice rows in deterministic order; the account lock above prevents concurrent
  -- withdrawals from spending the same balance while this operation validates all allocations.
  for v_allocation in
    select * from jsonb_to_recordset(v_canonical_allocations)
      as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric)
    where a.purchase_id is not null order by a.purchase_id
  loop
    select p.* into v_purchase from public.supplier_purchases p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=v_allocation.purchase_id
    for update;
    if not found then raise exception 'PURCHASE_NOT_FOUND' using errcode='P0001'; end if;
    if v_purchase.supplier_id<>p_supplier_id then raise exception 'SUPPLIER_PAYMENT_SUPPLIER_MISMATCH' using errcode='P0001'; end if;
    if v_purchase.status not in ('confirmed','partially_received','received') then
      raise exception 'PURCHASE_NOT_PAYABLE' using errcode='P0001';
    end if;
    select coalesce(sum(a.amount),0)::numeric(14,2) into v_paid_before
    from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
    where a.tenant_id=p_tenant_id and a.purchase_id=v_purchase.id;
    v_return_credit:=public.powerhub_inventory_purchase_supplier_return_credit(p_tenant_id,v_purchase.id);
    v_outstanding:=greatest(0,v_purchase.total_amount-v_paid_before-v_return_credit);
    if v_allocation.amount>v_outstanding then raise exception 'PURCHASE_BALANCE_EXCEEDED' using errcode='P0001'; end if;
    v_invoice_ids:=array_append(v_invoice_ids,v_purchase.id);
  end loop;

  for v_allocation in
    select * from jsonb_to_recordset(v_canonical_allocations)
      as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric)
    where a.supplier_ledger_entry_id is not null order by a.supplier_ledger_entry_id
  loop
    select e.* into v_opening from public.supplier_ledger_entries e
    where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=p_supplier_id
      and e.id=v_allocation.supplier_ledger_entry_id and e.entry_type='opening_balance'
      and e.purchase_id is null and e.supplier_payment_id is null and e.credit_amount>0
    for update;
    if not found then raise exception 'SUPPLIER_OPENING_BALANCE_NOT_PAYABLE' using errcode='P0001'; end if;
    select coalesce(sum(a.amount),0)::numeric(14,2) into v_paid_before
    from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
    where a.tenant_id=p_tenant_id and a.supplier_ledger_entry_id=v_opening.id;
    v_outstanding:=greatest(0,v_opening.credit_amount-v_paid_before);
    if v_allocation.amount>v_outstanding then raise exception 'SUPPLIER_OPENING_BALANCE_EXCEEDED' using errcode='P0001'; end if;
  end loop;

  select u.platform_role into v_actor_platform_role
  from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  select v_account.opening_balance+coalesce(sum(
    case when atx.transaction_type in ('deposit','transfer_in','collection') then atx.amount else -atx.amount end
  ),0)::numeric(14,2) into v_account_balance
  from public.account_transactions atx where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;
  if p_amount>v_account_balance then raise exception 'INSUFFICIENT_ACCOUNT_BALANCE' using errcode='P0001'; end if;

  select string_agg(p.purchase_number,', ' order by p.purchase_number) into v_invoice_summary
  from public.supplier_purchases p where p.tenant_id=p_tenant_id and p.id=any(v_invoice_ids);

  insert into public.supplier_payments(
    tenant_id,site_id,supplier_id,company_account_id,amount,payment_date,status,
    reference_no,notes,operation_key,operation_payload_hash,posted_at,posted_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_supplier_id,p_company_account_id,p_amount,v_date,'posted',
    v_reference,v_notes,v_operation_key,v_payload_hash,now(),p_user_id
  ) returning * into v_payment;

  insert into public.account_transactions(
    tenant_id,account_id,transaction_type,amount,description,reference_no,
    related_supplier_payment_id,created_by_user_id,occurred_at
  ) values (
    p_tenant_id,v_account.id,'withdrawal',p_amount,
    'دفعة للمورد '||v_supplier.name||
      case when v_invoice_summary is not null then ' — فواتير: '||v_invoice_summary else ' — تسوية رصيد افتتاحي' end,
    v_reference,v_payment.id,p_user_id,v_date::timestamptz
  ) returning id into v_account_transaction_id;

  update public.supplier_payments sp set account_transaction_id=v_account_transaction_id,updated_at=now()
  where sp.tenant_id=p_tenant_id and sp.id=v_payment.id;

  for v_allocation in
    select * from jsonb_to_recordset(v_canonical_allocations)
      as a(purchase_id bigint,supplier_ledger_entry_id bigint,amount numeric)
    order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0)
  loop
    insert into public.supplier_payment_allocations(
      tenant_id,payment_id,purchase_id,supplier_ledger_entry_id,amount
    ) values (p_tenant_id,v_payment.id,v_allocation.purchase_id,v_allocation.supplier_ledger_entry_id,v_allocation.amount);
  end loop;

  -- One supplier-level posting per payment keeps the existing uniqueness and statement model.
  -- Per-document allocation detail is carried by supplier_payment_allocations.
  insert into public.supplier_ledger_entries(
    tenant_id,site_id,supplier_id,entry_type,debit_amount,purchase_id,supplier_payment_id,
    entry_key,reference_no,description,occurred_at,created_by_user_id
  ) values (
    p_tenant_id,p_site_id,p_supplier_id,'payment',p_amount,null,v_payment.id,
    'supplier-payment:'||v_payment.id,v_reference,
    'دفعة للمورد '||v_supplier.name||case when v_invoice_summary is not null then ' — فواتير: '||v_invoice_summary else ' — تسوية رصيد افتتاحي' end,
    v_date::timestamptz,p_user_id
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'purchase_id',a.purchase_id,'supplier_ledger_entry_id',a.supplier_ledger_entry_id,
    'document_reference',coalesce(p.purchase_number,e.reference_no,'رصيد افتتاحي'),'amount',a.amount
  ) order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0)),'[]'::jsonb)
  into v_summary
  from public.supplier_payment_allocations a
  left join public.supplier_purchases p on p.tenant_id=a.tenant_id and p.id=a.purchase_id
  left join public.supplier_ledger_entries e on e.tenant_id=a.tenant_id and e.id=a.supplier_ledger_entry_id
  where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_actor_platform_role,'supplier_payment',v_payment.id::text,'post_batch_payment',
    jsonb_build_object('accountBalance',v_account_balance),
    jsonb_build_object('supplierId',p_supplier_id,'amount',p_amount,'paymentDate',v_date,
      'companyAccountId',v_account.id,'accountTransactionId',v_account_transaction_id,
      'allocations',v_summary,'accountBalanceAfter',v_account_balance-p_amount),
    jsonb_build_object('operationKey',v_operation_key,'payloadHash',v_payload_hash,'referenceNo',v_reference)
  );

  return query select v_payment.id,p_supplier_id,v_account.id,v_account_transaction_id,p_amount,v_date,
    v_allocation_count,v_summary,v_account_balance-p_amount,false;
end;
$$;

create or replace function public.powerhub_inventory_reverse_supplier_payment_flexible(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_payment_id bigint,
  p_reason text
)
returns table(
  payment_id bigint,purchase_id bigint,status text,amount numeric,
  paid_amount numeric,outstanding_amount numeric,account_balance numeric,replayed boolean
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_payment public.supplier_payments%rowtype;
  v_account public.company_accounts%rowtype;
  v_purchase public.supplier_purchases%rowtype;
  v_opening public.supplier_ledger_entries%rowtype;
  v_allocations_json jsonb;
  v_platform_role text;
  v_reason text:=nullif(btrim(p_reason),'');
  v_allocation record;
  v_allocation_count integer:=0;
  v_allocation_sum numeric(14,2):=0;
  v_single_purchase_id bigint;
  v_single_opening_id bigint;
  v_account_balance numeric(14,2):=0;
  v_paid_amount numeric(14,2):=0;
  v_outstanding numeric(14,2):=0;
  v_period_locked boolean:=false;
  v_replayed boolean:=false;
begin
  if p_tenant_id is null or p_site_id is null or p_user_id is null or p_payment_id is null then
    raise exception 'SUPPLIER_PAYMENT_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'SUPPLIER_PAYMENT_REVERSAL_REASON_REQUIRED' using errcode='P0001';
  end if;

  select sp.* into v_payment from public.supplier_payments sp
  where sp.tenant_id=p_tenant_id and sp.site_id=p_site_id and sp.id=p_payment_id
  for update;
  if not found then raise exception 'SUPPLIER_PAYMENT_NOT_FOUND' using errcode='P0001'; end if;

  select count(*)::integer,coalesce(sum(a.amount),0)::numeric(14,2),
    case when count(*)=1 then min(a.purchase_id) else null end,
    case when count(*)=1 then min(a.supplier_ledger_entry_id) else null end
  into v_allocation_count,v_allocation_sum,v_single_purchase_id,v_single_opening_id
  from public.supplier_payment_allocations a
  where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id;
  if v_allocation_count<1 or v_allocation_sum<>v_payment.amount then
    raise exception 'SUPPLIER_PAYMENT_ALLOCATION_MISMATCH' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(v_payment.company_account_id);
  select ca.* into v_account from public.company_accounts ca
  where ca.tenant_id=p_tenant_id and ca.id=v_payment.company_account_id
  for update;
  if not found then raise exception 'COMPANY_ACCOUNT_NOT_FOUND' using errcode='P0001'; end if;

  if v_payment.account_transaction_id is null or not exists(
    select 1 from public.account_transactions atx
    where atx.tenant_id=p_tenant_id and atx.id=v_payment.account_transaction_id
      and atx.account_id=v_payment.company_account_id and atx.transaction_type='withdrawal'
      and atx.amount=v_payment.amount and atx.related_supplier_payment_id=v_payment.id
  ) then
    raise exception 'SUPPLIER_PAYMENT_ORIGINAL_TRANSACTION_MISMATCH' using errcode='P0001';
  end if;

  -- Acquire all document locks in ascending order after the account lock.
  for v_allocation in
    select * from public.supplier_payment_allocations a
    where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id and a.purchase_id is not null
    order by a.purchase_id
  loop
    select p.* into v_purchase from public.supplier_purchases p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=v_allocation.purchase_id
    for update;
    if not found or v_purchase.supplier_id<>v_payment.supplier_id then
      raise exception 'SUPPLIER_PAYMENT_ALLOCATION_MISMATCH' using errcode='P0001';
    end if;
  end loop;
  for v_allocation in
    select * from public.supplier_payment_allocations a
    where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id and a.supplier_ledger_entry_id is not null
    order by a.supplier_ledger_entry_id
  loop
    select e.* into v_opening from public.supplier_ledger_entries e
    where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.supplier_id=v_payment.supplier_id
      and e.id=v_allocation.supplier_ledger_entry_id and e.entry_type='opening_balance'
    for update;
    if not found then raise exception 'SUPPLIER_PAYMENT_ALLOCATION_MISMATCH' using errcode='P0001'; end if;
  end loop;

  select v_account.opening_balance+coalesce(sum(
    case when atx.transaction_type in ('deposit','transfer_in','collection') then atx.amount else -atx.amount end
  ),0)::numeric(14,2) into v_account_balance
  from public.account_transactions atx where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;

  if v_payment.status='reversed' then
    v_replayed:=true;
  else
    select exists(
      select 1 from public.financial_settlements fs
      where fs.tenant_id=p_tenant_id and fs.site_id=p_site_id and fs.status='locked'
        and ((fs.period_start<=now() and fs.period_end>=now())
          or (fs.period_start::date<=v_payment.payment_date and fs.period_end::date>=v_payment.payment_date))
    ) into v_period_locked;
    if v_period_locked then raise exception 'FINANCIAL_PERIOD_LOCKED' using errcode='P0001'; end if;

    insert into public.account_transactions(
      tenant_id,account_id,transaction_type,amount,description,reference_no,
      related_supplier_payment_id,created_by_user_id,occurred_at
    ) values (
      p_tenant_id,v_account.id,'deposit',v_payment.amount,
      'عكس دفعة مورد #'||v_payment.id||' — '||v_reason,
      'REV-SUPPLIER-PAYMENT-'||v_payment.id,null,p_user_id,now()
    );

    insert into public.supplier_ledger_entries(
      tenant_id,site_id,supplier_id,entry_type,credit_amount,purchase_id,supplier_payment_id,
      entry_key,reference_no,description,occurred_at,created_by_user_id
    ) values (
      p_tenant_id,p_site_id,v_payment.supplier_id,'reversal',v_payment.amount,
      v_single_purchase_id,v_payment.id,'supplier-payment-reversal:'||v_payment.id,
      v_payment.reference_no,'عكس دفعة المورد #'||v_payment.id||' — '||v_reason,now(),p_user_id
    );

    update public.supplier_payments sp set status='reversed',reversed_at=now(),
      reversed_by_user_id=p_user_id,reversal_reason=v_reason,updated_at=now()
    where sp.tenant_id=p_tenant_id and sp.id=v_payment.id returning * into v_payment;

    select coalesce(jsonb_agg(jsonb_build_object(
      'purchaseId',a.purchase_id,'openingBalanceEntryId',a.supplier_ledger_entry_id,'amount',a.amount
    ) order by coalesce(a.purchase_id,0),coalesce(a.supplier_ledger_entry_id,0)),'[]'::jsonb)
    into v_allocations_json
    from public.supplier_payment_allocations a
    where a.tenant_id=p_tenant_id and a.payment_id=v_payment.id;

    select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
    ) values (
      p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier_payment',v_payment.id::text,'reverse',
      jsonb_build_object('status','posted','amount',v_payment.amount,'companyAccountId',v_account.id,
        'accountTransactionId',v_payment.account_transaction_id),
      jsonb_build_object('status','reversed','reversedAt',v_payment.reversed_at,'reason',v_reason),
      jsonb_build_object('allocations',v_allocations_json,'compensatingDepositReference','REV-SUPPLIER-PAYMENT-'||v_payment.id)
    );
  end if;

  select v_account.opening_balance+coalesce(sum(
    case when atx.transaction_type in ('deposit','transfer_in','collection') then atx.amount else -atx.amount end
  ),0)::numeric(14,2) into v_account_balance
  from public.account_transactions atx where atx.tenant_id=p_tenant_id and atx.account_id=v_account.id;

  if v_allocation_count=1 and v_single_purchase_id is not null then
    select p.* into v_purchase from public.supplier_purchases p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=v_single_purchase_id;
    select coalesce(sum(a.amount),0)::numeric(14,2) into v_paid_amount
    from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
    where a.tenant_id=p_tenant_id and a.purchase_id=v_single_purchase_id;
    v_outstanding:=greatest(0,v_purchase.total_amount-public.powerhub_inventory_purchase_supplier_return_credit(p_tenant_id,v_single_purchase_id)-v_paid_amount);
  elsif v_allocation_count=1 and v_single_opening_id is not null then
    select e.* into v_opening from public.supplier_ledger_entries e where e.tenant_id=p_tenant_id and e.id=v_single_opening_id;
    select coalesce(sum(a.amount),0)::numeric(14,2) into v_paid_amount
    from public.supplier_payment_allocations a
    join public.supplier_payments sp on sp.tenant_id=a.tenant_id and sp.id=a.payment_id and sp.status='posted'
    where a.tenant_id=p_tenant_id and a.supplier_ledger_entry_id=v_single_opening_id;
    v_outstanding:=greatest(0,v_opening.credit_amount-v_paid_amount);
  else
    v_single_purchase_id:=null;
    v_paid_amount:=null;
    v_outstanding:=null;
  end if;

  return query select v_payment.id,v_single_purchase_id,v_payment.status,v_payment.amount,
    v_paid_amount,v_outstanding,v_account_balance,v_replayed;
end;
$$;

create or replace function public.powerhub_inventory_create_item_unit(
  p_tenant_id bigint,
  p_site_id bigint,
  p_item_id bigint,
  p_user_id bigint,
  p_unit_label text,
  p_factor_to_base numeric
)
returns table(
  id bigint,tenant_id bigint,item_id bigint,unit_label text,factor_to_base numeric,
  is_active boolean,created_at timestamptz,updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_item public.inventory_items%rowtype;
  v_unit public.inventory_item_units%rowtype;
  v_platform_role text;
  v_label text:=btrim(coalesce(p_unit_label,''));
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select i.* into v_item from public.inventory_items i
    where i.tenant_id=p_tenant_id and i.id=p_item_id and i.is_active
    for update;
  if not found then raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode='P0001'; end if;
  if length(v_label) not between 1 and 40 or p_factor_to_base is null
    or p_factor_to_base<=0 or p_factor_to_base>99999999.999999
    or p_factor_to_base<>round(p_factor_to_base,6) then
    raise exception 'INVALID_ITEM_UNIT_CONVERSION' using errcode='P0001';
  end if;
  if lower(v_label)=lower(v_item.base_unit) then
    raise exception 'ITEM_UNIT_EQUALS_BASE_UNIT' using errcode='P0001';
  end if;
  select u.platform_role into v_platform_role
    from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.inventory_item_units(
    tenant_id,item_id,unit_label,factor_to_base,created_by_user_id
  ) values (p_tenant_id,p_item_id,v_label,p_factor_to_base,p_user_id)
  returning * into v_unit;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_item_unit',v_unit.id::text,'create',
    jsonb_build_object('itemId',v_unit.item_id,'unitLabel',v_unit.unit_label,
      'factorToBase',v_unit.factor_to_base,'isActive',v_unit.is_active)
  );
  return query select v_unit.id,v_unit.tenant_id,v_unit.item_id,v_unit.unit_label,
    v_unit.factor_to_base,v_unit.is_active,v_unit.created_at,v_unit.updated_at;
end;
$$;

create or replace function public.powerhub_inventory_set_item_unit_active(
  p_tenant_id bigint,
  p_site_id bigint,
  p_item_id bigint,
  p_unit_id bigint,
  p_user_id bigint,
  p_is_active boolean,
  p_reason text default null
)
returns table(
  id bigint,tenant_id bigint,item_id bigint,unit_label text,factor_to_base numeric,
  is_active boolean,created_at timestamptz,updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_unit public.inventory_item_units%rowtype;
  v_before jsonb;
  v_platform_role text;
  v_reason text:=nullif(btrim(p_reason),'');
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select u.* into v_unit from public.inventory_item_units u
    where u.tenant_id=p_tenant_id and u.item_id=p_item_id and u.id=p_unit_id
    for update;
  if not found then raise exception 'INVENTORY_ITEM_UNIT_NOT_FOUND' using errcode='P0001'; end if;
  if p_is_active is null then raise exception 'INVALID_ACTIVE_STATE' using errcode='P0001'; end if;
  if not p_is_active and (v_reason is null or length(v_reason)<3) then
    raise exception 'INVENTORY_DEACTIVATION_REASON_REQUIRED' using errcode='P0001';
  end if;
  if v_unit.is_active=p_is_active then
    return query select v_unit.id,v_unit.tenant_id,v_unit.item_id,v_unit.unit_label,
      v_unit.factor_to_base,v_unit.is_active,v_unit.created_at,v_unit.updated_at;
    return;
  end if;
  if not p_is_active and exists(
    select 1 from public.supplier_purchase_lines pl
    join public.supplier_purchases p on p.tenant_id=pl.tenant_id and p.id=pl.purchase_id
    where pl.tenant_id=p_tenant_id and pl.item_id=p_item_id
      and lower(btrim(pl.unit))=lower(btrim(v_unit.unit_label))
      and pl.received_quantity<pl.quantity and p.status in ('draft','confirmed','partially_received')
  ) then
    raise exception 'INVENTORY_ITEM_UNIT_HAS_OPEN_PURCHASE' using errcode='P0001';
  end if;

  v_before:=jsonb_build_object('itemId',v_unit.item_id,'unitLabel',v_unit.unit_label,
    'factorToBase',v_unit.factor_to_base,'isActive',v_unit.is_active);
  select u.platform_role into v_platform_role
    from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  update public.inventory_item_units u set is_active=p_is_active,updated_at=now()
    where u.tenant_id=p_tenant_id and u.item_id=p_item_id and u.id=p_unit_id
    returning * into v_unit;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,reason
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_item_unit',v_unit.id::text,
    case when p_is_active then 'reactivate' else 'deactivate' end,v_before,
    jsonb_build_object('itemId',v_unit.item_id,'unitLabel',v_unit.unit_label,
      'factorToBase',v_unit.factor_to_base,'isActive',v_unit.is_active),v_reason
  );
  return query select v_unit.id,v_unit.tenant_id,v_unit.item_id,v_unit.unit_label,
    v_unit.factor_to_base,v_unit.is_active,v_unit.created_at,v_unit.updated_at;
end;
$$;
