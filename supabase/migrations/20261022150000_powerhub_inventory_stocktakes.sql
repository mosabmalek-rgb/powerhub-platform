
-- Add fine-grained permissions for stocktake counting and posting.
alter table public.platform_role_policies
  drop constraint if exists platform_role_policies_capability_check;
alter table public.platform_role_policies
  add constraint platform_role_policies_capability_check
  check (capability = any (array[
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
    'manageMessaging','viewAudit','viewInventory','manageInventoryItems','manageSuppliers',
    'createPurchases','approvePurchases','receiveInventory','manageSupplierPayments',
    'viewSupplierLedger','issueInventory','adjustInventory','manageFuelAndConsumption',
    'manageMaintenance','viewInventoryReports','viewStocktakes','manageStocktakes','approveStocktakes'
  ]));

alter table public.staff_profile_capability_overrides
  drop constraint if exists staff_profile_capability_overrides_capability_check;
alter table public.staff_profile_capability_overrides
  add constraint staff_profile_capability_overrides_capability_check
  check (capability = any (array[
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
    'manageMessaging','viewAudit','viewInventory','manageInventoryItems','manageSuppliers',
    'createPurchases','approvePurchases','receiveInventory','manageSupplierPayments',
    'viewSupplierLedger','issueInventory','adjustInventory','manageFuelAndConsumption',
    'manageMaintenance','viewInventoryReports','viewStocktakes','manageStocktakes','approveStocktakes'
  ]));


create or replace function public.powerhub_admin_set_staff_capability_override(
  p_actor_user_id bigint,
  p_profile_id bigint,
  p_capability text,
  p_is_allowed boolean
)
returns table(success boolean, profile_id bigint, capability text, is_allowed boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor public.users%rowtype;
  v_profile public.staff_profiles%rowtype;
  v_previous boolean;
begin
  select * into v_actor from public.users
  where id = p_actor_user_id and role = 'admin' and account_status = 'active'
    and platform_role in ('platform_owner','platform_admin');
  if not found then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='P0001';
  end if;

  if p_capability not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
    'manageMessaging','viewAudit',
    'viewInventory','manageInventoryItems','manageSuppliers','createPurchases',
    'approvePurchases','receiveInventory','manageSupplierPayments','viewSupplierLedger',
    'issueInventory','adjustInventory','manageFuelAndConsumption','manageMaintenance',
    'viewInventoryReports','viewStocktakes','manageStocktakes','approveStocktakes'
  ) then
    raise exception 'INVALID_CAPABILITY' using errcode='P0001';
  end if;

  select * into v_profile from public.staff_profiles
  where id = p_profile_id and tenant_id is not null;
  if not found then
    raise exception 'STAFF_PROFILE_NOT_FOUND' using errcode='P0001';
  end if;
  if v_profile.role = 'owner' then
    raise exception 'OWNER_PERMISSION_OVERRIDE_NOT_SUPPORTED' using errcode='P0001';
  end if;

  select existing_override.is_allowed into v_previous
  from public.staff_profile_capability_overrides as existing_override
  where existing_override.tenant_id = v_profile.tenant_id
    and existing_override.profile_id = v_profile.id
    and existing_override.capability = p_capability;

  insert into public.staff_profile_capability_overrides
    (tenant_id, profile_id, capability, is_allowed, updated_by_user_id, updated_at)
  values
    (v_profile.tenant_id, v_profile.id, p_capability, p_is_allowed, p_actor_user_id, now())
  on conflict on constraint staff_profile_capability_override_unique do update
    set is_allowed = excluded.is_allowed,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = now();

  insert into public.staff_profile_permission_audit
    (tenant_id, profile_id, actor_user_id, capability, previous_is_allowed, new_is_allowed)
  values
    (v_profile.tenant_id, v_profile.id, p_actor_user_id, p_capability, v_previous, p_is_allowed);

  return query select true, v_profile.id, p_capability, p_is_allowed;
end;
$$;
revoke execute on function public.powerhub_admin_set_staff_capability_override(bigint,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_admin_set_staff_capability_override(bigint,bigint,text,boolean) to service_role;

create or replace function public.powerhub_admin_save_role_policy(
  p_actor_user_id bigint,
  p_role text,
  p_capability text,
  p_is_allowed boolean
)
returns table(success boolean, policy_id bigint, role text, capability text, is_allowed boolean, replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_id bigint;
begin
  if not exists (
    select 1 from public.users
    where id = p_actor_user_id
      and role = 'admin'
      and account_status = 'active'
      and platform_role in ('platform_owner','platform_admin')
  ) then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='P0001';
  end if;
  if p_role not in ('owner','manager','accountant','collector','technician','viewer') then
    raise exception 'INVALID_ROLE' using errcode='P0001';
  end if;
  if p_capability not in (
    'manageSubscribers','manageGenerators','recordReadings','accessFieldApp',
    'approveReadings','manageTariffs','issueInvoices','collectPayments',
    'approvePaymentDocumentation','manageExpenses','managePayroll','manageTeam',
    'manageMessaging','viewAudit',
    'viewInventory','manageInventoryItems','manageSuppliers','createPurchases',
    'approvePurchases','receiveInventory','manageSupplierPayments','viewSupplierLedger',
    'issueInventory','adjustInventory','manageFuelAndConsumption','manageMaintenance',
    'viewInventoryReports','viewStocktakes','manageStocktakes','approveStocktakes'
  ) then
    raise exception 'INVALID_CAPABILITY' using errcode='P0001';
  end if;
  insert into public.platform_role_policies(role,capability,is_allowed,updated_by_user_id,updated_at)
  values(p_role,p_capability,p_is_allowed,p_actor_user_id,now())
  on conflict(role,capability) do update
    set is_allowed=excluded.is_allowed,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()
  returning id into v_id;
  return query select true,v_id,p_role,p_capability,p_is_allowed,false;
end;
$$;
revoke execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) from public,anon,authenticated;
grant execute on function public.powerhub_admin_save_role_policy(bigint,text,text,boolean) to service_role;
-- Complete, audited physical stocktakes with snapshot drift protection and atomic posting.
create unique index if not exists inventory_warehouses_tenant_site_id_unique_idx
  on public.inventory_warehouses(tenant_id,site_id,id);

create table public.inventory_stocktakes (
  id bigint generated by default as identity primary key,
  tenant_id bigint not null references public.tenants(id) on delete cascade,
  site_id bigint not null,
  warehouse_id bigint not null,
  stocktake_number text,
  status text not null default 'counting'
    check (status in ('counting','submitted','posted','cancelled')),
  reason text not null check (length(trim(reason)) between 3 and 500),
  notes text,
  operation_key text not null check (length(trim(operation_key)) between 1 and 180),
  operation_payload_hash text not null,
  snapshot_at timestamptz not null default now(),
  created_by_user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  submitted_by_user_id bigint references public.users(id) on delete set null,
  posted_at timestamptz,
  posted_by_user_id bigint references public.users(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by_user_id bigint references public.users(id) on delete set null,
  cancel_reason text,
  unique (tenant_id,id),
  unique (tenant_id,operation_key),
  unique (tenant_id,site_id,stocktake_number),
  constraint inventory_stocktakes_site_fk foreign key (tenant_id,site_id)
    references public.sites(tenant_id,id) on delete restrict,
  constraint inventory_stocktakes_warehouse_fk foreign key (tenant_id,site_id,warehouse_id)
    references public.inventory_warehouses(tenant_id,site_id,id) on delete restrict,
  constraint inventory_stocktakes_status_fields_ck check (
    (status<>'submitted' or (submitted_at is not null and submitted_by_user_id is not null))
    and (status<>'posted' or (posted_at is not null and posted_by_user_id is not null))
    and (status<>'cancelled' or (cancelled_at is not null and cancelled_by_user_id is not null and cancel_reason is not null))
  )
);

create unique index inventory_stocktakes_one_open_per_warehouse_idx
  on public.inventory_stocktakes(tenant_id,site_id,warehouse_id)
  where status in ('counting','submitted');
create index inventory_stocktakes_site_recent_idx
  on public.inventory_stocktakes(tenant_id,site_id,created_at desc,id desc);
create index inventory_stocktakes_warehouse_status_idx
  on public.inventory_stocktakes(tenant_id,warehouse_id,status,created_at desc);

create table public.inventory_stocktake_lines (
  id bigint generated by default as identity primary key,
  tenant_id bigint not null references public.tenants(id) on delete cascade,
  stocktake_id bigint not null,
  item_id bigint not null,
  system_quantity numeric(14,3) not null check (system_quantity>=0),
  system_value numeric(14,2) not null check (system_value>=0),
  system_unit_cost numeric(14,4) not null check (system_unit_cost>=0),
  counted_quantity numeric(14,3) check (counted_quantity>=0),
  counted_unit_cost numeric(14,4) check (counted_unit_cost>=0),
  variance_quantity numeric(14,3) generated always as (
    case when counted_quantity is null then null else counted_quantity-system_quantity end
  ) stored,
  count_notes text,
  counted_by_user_id bigint references public.users(id) on delete set null,
  counted_at timestamptz,
  posted_movement_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,id),
  unique (tenant_id,stocktake_id,item_id),
  constraint inventory_stocktake_lines_header_fk foreign key (tenant_id,stocktake_id)
    references public.inventory_stocktakes(tenant_id,id) on delete restrict,
  constraint inventory_stocktake_lines_item_fk foreign key (tenant_id,item_id)
    references public.inventory_items(tenant_id,id) on delete restrict,
  constraint inventory_stocktake_lines_counted_state_ck check (
    (counted_quantity is null and counted_by_user_id is null and counted_at is null)
    or (counted_quantity is not null and counted_by_user_id is not null and counted_at is not null)
  ),
  constraint inventory_stocktake_lines_posted_movement_fk foreign key (tenant_id,posted_movement_id)
    references public.inventory_stock_movements(tenant_id,id) on delete restrict
);
create index inventory_stocktake_lines_header_idx
  on public.inventory_stocktake_lines(tenant_id,stocktake_id,item_id);
create index inventory_stocktake_lines_posted_movement_idx
  on public.inventory_stocktake_lines(tenant_id,posted_movement_id) where posted_movement_id is not null;

alter table public.inventory_stocktakes enable row level security;
alter table public.inventory_stocktake_lines enable row level security;
revoke all on public.inventory_stocktakes,public.inventory_stocktake_lines from public,anon,authenticated;
grant select,insert,update on public.inventory_stocktakes,public.inventory_stocktake_lines to service_role;
grant usage,select on sequence public.inventory_stocktakes_id_seq,public.inventory_stocktake_lines_id_seq to service_role;

-- Fuel tanks can contain fuel catalogue items only, regardless of which server workflow posts a movement.
create or replace function public.powerhub_inventory_validate_location_item()
returns trigger
language plpgsql
security invoker
set search_path=public,pg_temp
as $
declare
  v_location_type text;
  v_category text;
begin
  select w.location_type,i.category into v_location_type,v_category
  from public.inventory_warehouses w
  join public.inventory_items i on i.tenant_id=new.tenant_id and i.id=new.item_id
  where w.tenant_id=new.tenant_id and w.site_id=new.site_id and w.id=new.warehouse_id;
  if not found then raise exception 'STOCK_WAREHOUSE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_location_type in ('fixed_fuel_tank','generator_fuel_tank') and v_category<>'fuel' then
    raise exception 'FUEL_ITEM_REQUIRED_FOR_TANK' using errcode='P0001';
  end if;
  return new;
end;
$;
drop trigger if exists inventory_stock_movements_location_item_guard on public.inventory_stock_movements;
create trigger inventory_stock_movements_location_item_guard
before insert on public.inventory_stock_movements
for each row execute function public.powerhub_inventory_validate_location_item();

-- Keep stock overview aligned with typed storage locations: tanks expose only fuel catalogue items.
create or replace function public.powerhub_inventory_stock_overview(
  p_tenant_id bigint,
  p_site_id bigint
)
returns table(
  warehouse_id bigint,warehouse_code text,warehouse_name text,item_id bigint,sku text,item_name text,
  category text,base_unit text,reorder_point numeric,on_hand_quantity numeric,stock_value numeric,
  average_unit_cost numeric,below_reorder_point boolean
)
language sql
stable
security invoker
set search_path=public,pg_temp
as $
  with balances as (
    select m.tenant_id,m.site_id,m.warehouse_id,m.item_id,
      sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.quantity else -m.quantity end)::numeric(14,3) as on_hand_quantity,
      sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.total_cost_amount else -m.total_cost_amount end)::numeric(14,2) as stock_value
    from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id
    group by m.tenant_id,m.site_id,m.warehouse_id,m.item_id
  )
  select w.id,w.code,w.name,i.id,i.sku,i.name,i.category,i.base_unit,i.reorder_point,
    coalesce(b.on_hand_quantity,0)::numeric(14,3),greatest(coalesce(b.stock_value,0),0)::numeric(14,2),
    case when coalesce(b.on_hand_quantity,0)>0
      then (greatest(coalesce(b.stock_value,0),0)/b.on_hand_quantity)::numeric(14,4)
      else 0::numeric end,
    coalesce(b.on_hand_quantity,0)<=i.reorder_point
  from public.inventory_warehouses w
  join public.inventory_items i on i.tenant_id=w.tenant_id and i.is_active=true
  left join balances b on b.tenant_id=w.tenant_id and b.site_id=w.site_id
    and b.warehouse_id=w.id and b.item_id=i.id
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.is_active=true
    and (w.location_type not in ('fixed_fuel_tank','generator_fuel_tank') or i.category='fuel')
    and (coalesce(b.on_hand_quantity,0)>0 or (i.reorder_point>0 and coalesce(b.on_hand_quantity,0)<=i.reorder_point))
  order by (coalesce(b.on_hand_quantity,0)<=i.reorder_point) desc,i.name,w.name
  limit 5000;
$;

create or replace function public.powerhub_inventory_stocktake_snapshot_is_current(
  p_tenant_id bigint,p_site_id bigint,p_stocktake_id bigint
)
returns boolean
language plpgsql
stable
security invoker
set search_path=public,pg_temp
as $$
declare
  v_warehouse_id bigint;
  v_location_type text;
  v_valid boolean;
begin
  select st.warehouse_id,w.location_type into v_warehouse_id,v_location_type
  from public.inventory_stocktakes st
  join public.inventory_warehouses w
    on w.tenant_id=st.tenant_id and w.site_id=st.site_id and w.id=st.warehouse_id
  where st.tenant_id=p_tenant_id and st.site_id=p_site_id and st.id=p_stocktake_id;
  if not found then return false; end if;

  if exists(
    select 1 from public.inventory_items i
    where i.tenant_id=p_tenant_id and i.is_active
      and (v_location_type not in ('fixed_fuel_tank','generator_fuel_tank') or i.category='fuel')
      and not exists(select 1 from public.inventory_stocktake_lines l
        where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id and l.item_id=i.id)
  ) or exists(
    select 1 from public.inventory_stocktake_lines l
    join public.inventory_items i on i.tenant_id=l.tenant_id and i.id=l.item_id
    where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id
      and (not i.is_active or (v_location_type in ('fixed_fuel_tank','generator_fuel_tank') and i.category<>'fuel'))
  ) then return false; end if;

  select not exists(
    select 1
    from public.inventory_stocktake_lines l
    left join lateral(
      select coalesce(sum(case
        when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
          then m.quantity else -m.quantity end),0)::numeric(14,3) as quantity,
        greatest(coalesce(sum(case
          when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
            then m.total_cost_amount else -m.total_cost_amount end),0),0)::numeric(14,2) as value
      from public.inventory_stock_movements m
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id
        and m.warehouse_id=v_warehouse_id and m.item_id=l.item_id
    ) current_balance on true
    where l.tenant_id=p_tenant_id and l.stocktake_id=p_stocktake_id
      and (
        abs(current_balance.quantity-l.system_quantity)>0.0005
        or abs(current_balance.value-l.system_value)>0.01
      )
  ) into v_valid;
  return coalesce(v_valid,false);
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

  select coalesce(u.platform_role,'tenant_user') into v_platform_role
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
  select coalesce(u.platform_role,'tenant_user') into v_platform_role from public.users u where u.id=p_user_id;
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

  select coalesce(u.platform_role,'tenant_user') into v_platform_role from public.users u where u.id=p_user_id;
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
  select coalesce(u.platform_role,'tenant_user') into v_platform_role from public.users u where u.id=p_user_id;
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
  v_reason text:=nullif(btrim(p_reason),'');
begin
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'STOCKTAKE_CANCEL_REASON_REQUIRED' using errcode='P0001';
  end if;
  select st.* into v_stocktake from public.inventory_stocktakes st
  where st.tenant_id=p_tenant_id and st.site_id=p_site_id and st.id=p_stocktake_id for update;
  if not found then raise exception 'STOCKTAKE_NOT_FOUND' using errcode='P0001'; end if;
  if v_stocktake.status='cancelled' then return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,true; return; end if;
  if v_stocktake.status<>'counting' then raise exception 'STOCKTAKE_NOT_CANCELLABLE' using errcode='P0001'; end if;
  select coalesce(u.platform_role,'tenant_user') into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  update public.inventory_stocktakes st set status='cancelled',cancelled_at=now(),cancelled_by_user_id=p_user_id,cancel_reason=v_reason
  where st.tenant_id=p_tenant_id and st.id=p_stocktake_id returning * into v_stocktake;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_stocktake',v_stocktake.id::text,'cancel',
    jsonb_build_object('status','counting'),jsonb_build_object('status','cancelled','reason',v_reason)
  );
  return query select v_stocktake.id,v_stocktake.stocktake_number,v_stocktake.status,false;
end;
$$;

create or replace function public.powerhub_inventory_list_stocktakes(
  p_tenant_id bigint,p_site_id bigint,p_warehouse_id bigint default null,p_limit integer default 50
)
returns table(
  stocktake_id bigint,stocktake_number text,warehouse_id bigint,warehouse_name text,location_type text,
  status text,reason text,notes text,snapshot_at timestamptz,created_at timestamptz,
  created_by_user_id bigint,submitted_at timestamptz,submitted_by_user_id bigint,
  posted_at timestamptz,posted_by_user_id bigint,item_count integer,counted_count integer,
  variance_count integer,variance_quantity numeric
)
language sql
stable
security invoker
set search_path=public,pg_temp
as $$
  select st.id,st.stocktake_number,st.warehouse_id,w.name,w.location_type,st.status,st.reason,st.notes,
    st.snapshot_at,st.created_at,st.created_by_user_id,st.submitted_at,st.submitted_by_user_id,
    st.posted_at,st.posted_by_user_id,count(l.id)::integer,
    count(l.id) filter(where l.counted_quantity is not null)::integer,
    count(l.id) filter(where l.variance_quantity<>0)::integer,
    coalesce(sum(l.variance_quantity),0)::numeric(14,3)
  from public.inventory_stocktakes st
  join public.inventory_warehouses w
    on w.tenant_id=st.tenant_id and w.site_id=st.site_id and w.id=st.warehouse_id
  left join public.inventory_stocktake_lines l on l.tenant_id=st.tenant_id and l.stocktake_id=st.id
  where st.tenant_id=p_tenant_id and st.site_id=p_site_id
    and (p_warehouse_id is null or st.warehouse_id=p_warehouse_id)
  group by st.id,w.name,w.location_type
  order by st.created_at desc,st.id desc
  limit greatest(1,least(coalesce(p_limit,50),200));
$$;

create or replace function public.powerhub_inventory_list_stocktake_lines(
  p_tenant_id bigint,p_site_id bigint,p_stocktake_id bigint
)
returns table(
  item_id bigint,sku text,item_name text,category text,base_unit text,
  system_quantity numeric,system_value numeric,system_unit_cost numeric,
  counted_quantity numeric,counted_unit_cost numeric,variance_quantity numeric,
  count_notes text,counted_by_user_id bigint,counted_at timestamptz,posted_movement_id bigint
)
language sql
stable
security invoker
set search_path=public,pg_temp
as $$
  select i.id,i.sku,i.name,i.category,i.base_unit,l.system_quantity,l.system_value,l.system_unit_cost,
    l.counted_quantity,l.counted_unit_cost,l.variance_quantity,l.count_notes,l.counted_by_user_id,l.counted_at,l.posted_movement_id
  from public.inventory_stocktakes st
  join public.inventory_stocktake_lines l on l.tenant_id=st.tenant_id and l.stocktake_id=st.id
  join public.inventory_items i on i.tenant_id=l.tenant_id and i.id=l.item_id
  where st.tenant_id=p_tenant_id and st.site_id=p_site_id and st.id=p_stocktake_id
  order by i.name,i.id;
$$;

revoke all on function public.powerhub_inventory_stocktake_snapshot_is_current(bigint,bigint,bigint) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_create_stocktake(bigint,bigint,bigint,bigint,text,text,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_record_stocktake_count(bigint,bigint,bigint,bigint,bigint,numeric,numeric,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_submit_stocktake(bigint,bigint,bigint,bigint) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_post_stocktake(bigint,bigint,bigint,bigint) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_cancel_stocktake(bigint,bigint,bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_list_stocktakes(bigint,bigint,bigint,integer) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_list_stocktake_lines(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_stocktake_snapshot_is_current(bigint,bigint,bigint) to service_role;
grant execute on function public.powerhub_inventory_create_stocktake(bigint,bigint,bigint,bigint,text,text,text) to service_role;
grant execute on function public.powerhub_inventory_record_stocktake_count(bigint,bigint,bigint,bigint,bigint,numeric,numeric,text) to service_role;
grant execute on function public.powerhub_inventory_submit_stocktake(bigint,bigint,bigint,bigint) to service_role;
grant execute on function public.powerhub_inventory_post_stocktake(bigint,bigint,bigint,bigint) to service_role;
grant execute on function public.powerhub_inventory_cancel_stocktake(bigint,bigint,bigint,bigint,text) to service_role;
grant execute on function public.powerhub_inventory_list_stocktakes(bigint,bigint,bigint,integer) to service_role;
grant execute on function public.powerhub_inventory_list_stocktake_lines(bigint,bigint,bigint) to service_role;

