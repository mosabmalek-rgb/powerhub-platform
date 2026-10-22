-- Complete the lifecycle of inventory master data without deleting historical records.
-- Mutations are tenant-scoped, audited in the same transaction, and exposed only to service_role.
-- The trusted server must enforce the appropriate per-user capability before invoking these RPCs.

create or replace function public.powerhub_inventory_update_item(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_item_id bigint,
  p_sku text, p_name text, p_category text, p_base_unit text, p_reorder_point numeric,
  p_specification text, p_notes text
)
returns table(
  id bigint, tenant_id bigint, sku text, name text, category text, base_unit text,
  reorder_point numeric, specification text, notes text, is_active boolean,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_item public.inventory_items%rowtype;
  v_before jsonb;
  v_platform_role text;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 180
    or p_category not in ('fuel','oil','filter','spare_part','maintenance_supply','other')
    or p_base_unit not in ('liter','milliliter','piece','container','kg','gram','meter','set','gallon','other')
    or p_reorder_point is null or p_reorder_point<0 then
    raise exception 'INVALID_INVENTORY_ITEM' using errcode='P0001';
  end if;
  select i.* into v_item from public.inventory_items i
  where i.tenant_id=p_tenant_id and i.id=p_item_id for update;
  if not found then raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode='P0001'; end if;

  if p_base_unit is distinct from v_item.base_unit and (
    exists(select 1 from public.inventory_stock_movements m where m.tenant_id=p_tenant_id and m.item_id=p_item_id)
    or exists(select 1 from public.supplier_purchase_lines l where l.tenant_id=p_tenant_id and l.item_id=p_item_id)
  ) then
    raise exception 'ITEM_BASE_UNIT_IMMUTABLE_AFTER_USE' using errcode='P0001';
  end if;
  if (
    p_sku is distinct from v_item.sku
    or btrim(p_name) is distinct from v_item.name
    or p_category is distinct from v_item.category
  ) and (
    exists(select 1 from public.inventory_stock_movements m where m.tenant_id=p_tenant_id and m.item_id=p_item_id)
    or exists(select 1 from public.supplier_purchase_lines l where l.tenant_id=p_tenant_id and l.item_id=p_item_id)
  ) then
    raise exception 'ITEM_IDENTITY_IMMUTABLE_AFTER_USE' using errcode='P0001';
  end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  v_before:=jsonb_build_object(
    'sku',v_item.sku,'name',v_item.name,'category',v_item.category,'baseUnit',v_item.base_unit,
    'reorderPoint',v_item.reorder_point,'specification',v_item.specification,'notes',v_item.notes
  );

  update public.inventory_items i set
    sku=nullif(btrim(p_sku),''),name=btrim(p_name),category=p_category,base_unit=p_base_unit,
    reorder_point=p_reorder_point,specification=nullif(btrim(p_specification),''),
    notes=nullif(btrim(p_notes),''),updated_at=now()
  where i.tenant_id=p_tenant_id and i.id=p_item_id returning i.* into v_item;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_item',v_item.id::text,'update',v_before,
    jsonb_build_object('sku',v_item.sku,'name',v_item.name,'category',v_item.category,'baseUnit',v_item.base_unit,
      'reorderPoint',v_item.reorder_point,'specification',v_item.specification,'notes',v_item.notes)
  );
  return query select v_item.id,v_item.tenant_id,v_item.sku,v_item.name,v_item.category,v_item.base_unit,
    v_item.reorder_point,v_item.specification,v_item.notes,v_item.is_active,v_item.created_at,v_item.updated_at;
end;
$$;

create or replace function public.powerhub_inventory_set_item_active(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_item_id bigint,p_is_active boolean,p_reason text default null
)
returns table(id bigint,is_active boolean,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_item public.inventory_items%rowtype;
  v_platform_role text;
  v_reason text:=nullif(btrim(p_reason),'');
  v_replayed boolean:=false;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_is_active is null then raise exception 'INVALID_ACTIVE_STATE' using errcode='P0001'; end if;
  if not p_is_active and (v_reason is null or length(v_reason)<3 or length(v_reason)>500) then
    raise exception 'INVENTORY_DEACTIVATION_REASON_REQUIRED' using errcode='P0001';
  end if;

  select i.* into v_item from public.inventory_items i
  where i.tenant_id=p_tenant_id and i.id=p_item_id for update;
  if not found then raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode='P0001'; end if;
  if v_item.is_active=p_is_active then
    return query select v_item.id,v_item.is_active,true;
    return;
  end if;
  if not p_is_active then
    if exists (
      select 1 from (
        select m.site_id,m.warehouse_id,
          sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
            then m.quantity else -m.quantity end) as qty,
          sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
            then m.total_cost_amount else -m.total_cost_amount end) as value
        from public.inventory_stock_movements m
        where m.tenant_id=p_tenant_id and m.item_id=p_item_id
        group by m.site_id,m.warehouse_id
      ) balances where balances.qty<>0 or balances.value<>0
    ) then raise exception 'INVENTORY_ITEM_HAS_STOCK' using errcode='P0001'; end if;

    if exists (
      select 1 from public.supplier_purchase_lines l
      join public.supplier_purchases p on p.tenant_id=l.tenant_id and p.id=l.purchase_id
      where l.tenant_id=p_tenant_id and l.item_id=p_item_id
        and p.status in ('draft','confirmed','partially_received')
        and l.quantity>l.received_quantity
    ) then raise exception 'INVENTORY_ITEM_HAS_OPEN_PURCHASE' using errcode='P0001'; end if;
  end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  update public.inventory_items i set is_active=p_is_active,updated_at=now()
  where i.tenant_id=p_tenant_id and i.id=p_item_id returning i.* into v_item;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_item',v_item.id::text,
    case when p_is_active then 'reactivate' else 'deactivate' end,
    jsonb_build_object('isActive',not p_is_active),
    jsonb_build_object('isActive',p_is_active),
    jsonb_build_object('reason',v_reason,'historicalRowsPreserved',true)
  );
  return query select v_item.id,v_item.is_active,v_replayed;
end;
$$;

create or replace function public.powerhub_inventory_update_supplier(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_supplier_id bigint,
  p_supplier_code text,p_name text,p_contact_name text,p_phone text,p_email text,
  p_address text,p_tax_number text,p_default_payment_terms_days integer,p_notes text
)
returns table(
  id bigint,tenant_id bigint,supplier_code text,name text,contact_name text,phone text,
  email text,address text,tax_number text,default_payment_terms_days integer,notes text,
  is_active boolean,created_at timestamptz,updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_supplier public.suppliers%rowtype;
  v_before jsonb;
  v_platform_role text;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 180
    or p_default_payment_terms_days is null or p_default_payment_terms_days not between 0 and 3650
    or (nullif(btrim(p_email),'') is not null and btrim(p_email) !~* '^[A-Z0-9._%+%-]+@[A-Z0-9.-]+\.[A-Z]{2,}$') then
    raise exception 'INVALID_SUPPLIER_PROFILE' using errcode='P0001';
  end if;
  select s.* into v_supplier from public.suppliers s where s.tenant_id=p_tenant_id and s.id=p_supplier_id for update;
  if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  v_before:=jsonb_build_object(
    'supplierCode',v_supplier.supplier_code,'name',v_supplier.name,'contactName',v_supplier.contact_name,
    'phone',v_supplier.phone,'email',v_supplier.email,'address',v_supplier.address,'taxNumber',v_supplier.tax_number,
    'defaultPaymentTermsDays',v_supplier.default_payment_terms_days,'notes',v_supplier.notes
  );
  update public.suppliers s set
    supplier_code=nullif(btrim(p_supplier_code),''),name=btrim(p_name),
    contact_name=nullif(btrim(p_contact_name),''),phone=nullif(btrim(p_phone),''),
    email=nullif(btrim(p_email),''),address=nullif(btrim(p_address),''),tax_number=nullif(btrim(p_tax_number),''),
    default_payment_terms_days=p_default_payment_terms_days,notes=nullif(btrim(p_notes),''),updated_at=now()
  where s.tenant_id=p_tenant_id and s.id=p_supplier_id returning s.* into v_supplier;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier',v_supplier.id::text,'update',v_before,
    jsonb_build_object('supplierCode',v_supplier.supplier_code,'name',v_supplier.name,'contactName',v_supplier.contact_name,
      'phone',v_supplier.phone,'email',v_supplier.email,'address',v_supplier.address,'taxNumber',v_supplier.tax_number,
      'defaultPaymentTermsDays',v_supplier.default_payment_terms_days,'notes',v_supplier.notes)
  );
  return query select v_supplier.id,v_supplier.tenant_id,v_supplier.supplier_code,v_supplier.name,
    v_supplier.contact_name,v_supplier.phone,v_supplier.email,v_supplier.address,v_supplier.tax_number,
    v_supplier.default_payment_terms_days,v_supplier.notes,v_supplier.is_active,v_supplier.created_at,v_supplier.updated_at;
end;
$$;

create or replace function public.powerhub_inventory_set_supplier_active(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_supplier_id bigint,p_is_active boolean,p_reason text default null
)
returns table(id bigint,is_active boolean,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_supplier public.suppliers%rowtype;
  v_platform_role text;
  v_reason text:=nullif(btrim(p_reason),'');
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_is_active is null then raise exception 'INVALID_ACTIVE_STATE' using errcode='P0001'; end if;
  if not p_is_active and (v_reason is null or length(v_reason)<3 or length(v_reason)>500) then
    raise exception 'SUPPLIER_DEACTIVATION_REASON_REQUIRED' using errcode='P0001';
  end if;
  select s.* into v_supplier from public.suppliers s where s.tenant_id=p_tenant_id and s.id=p_supplier_id for update;
  if not found then raise exception 'SUPPLIER_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_supplier.is_active=p_is_active then return query select v_supplier.id,v_supplier.is_active,true; return; end if;

  if not p_is_active then
    if exists(
      select 1 from public.supplier_ledger_entries e
      where e.tenant_id=p_tenant_id and e.supplier_id=p_supplier_id
      group by e.site_id having sum(e.credit_amount-e.debit_amount)>0.005
    ) then raise exception 'SUPPLIER_HAS_OUTSTANDING_PAYABLE' using errcode='P0001'; end if;
    if exists(
      select 1 from public.supplier_purchases p
      where p.tenant_id=p_tenant_id and p.supplier_id=p_supplier_id
        and p.status in ('draft','confirmed','partially_received')
    ) then raise exception 'SUPPLIER_HAS_OPEN_PURCHASE' using errcode='P0001'; end if;
  end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  update public.suppliers s set is_active=p_is_active,updated_at=now()
  where s.tenant_id=p_tenant_id and s.id=p_supplier_id returning s.* into v_supplier;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier',v_supplier.id::text,
    case when p_is_active then 'reactivate' else 'deactivate' end,
    jsonb_build_object('isActive',not p_is_active),jsonb_build_object('isActive',p_is_active),
    jsonb_build_object('reason',v_reason,'historicalRowsPreserved',true)
  );
  return query select v_supplier.id,v_supplier.is_active,false;
end;
$$;

create or replace function public.powerhub_inventory_update_warehouse(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_warehouse_id bigint,p_code text,p_name text,p_notes text
)
returns table(id bigint,tenant_id bigint,site_id bigint,code text,name text,notes text,is_active boolean,created_at timestamptz,updated_at timestamptz)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_warehouse public.inventory_warehouses%rowtype;
  v_before jsonb;
  v_platform_role text;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_code is null or length(trim(p_code)) not between 1 and 40
    or p_name is null or length(trim(p_name)) not between 1 and 120 then
    raise exception 'INVALID_INVENTORY_WAREHOUSE' using errcode='P0001';
  end if;
  select w.* into v_warehouse from public.inventory_warehouses w
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_warehouse_id for update;
  if not found then raise exception 'STOCK_WAREHOUSE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  v_before:=jsonb_build_object('code',v_warehouse.code,'name',v_warehouse.name,'notes',v_warehouse.notes);
  update public.inventory_warehouses w set code=btrim(p_code),name=btrim(p_name),
    notes=nullif(btrim(p_notes),''),updated_at=now()
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_warehouse_id returning w.* into v_warehouse;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_warehouse',v_warehouse.id::text,'update',v_before,
    jsonb_build_object('code',v_warehouse.code,'name',v_warehouse.name,'notes',v_warehouse.notes)
  );
  return query select v_warehouse.id,v_warehouse.tenant_id,v_warehouse.site_id,v_warehouse.code,v_warehouse.name,
    v_warehouse.notes,v_warehouse.is_active,v_warehouse.created_at,v_warehouse.updated_at;
end;
$$;

create or replace function public.powerhub_inventory_set_warehouse_active(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_warehouse_id bigint,p_is_active boolean,p_reason text default null
)
returns table(id bigint,is_active boolean,replayed boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_warehouse public.inventory_warehouses%rowtype;
  v_platform_role text;
  v_reason text:=nullif(btrim(p_reason),'');
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_is_active is null then raise exception 'INVALID_ACTIVE_STATE' using errcode='P0001'; end if;
  if not p_is_active and (v_reason is null or length(v_reason)<3 or length(v_reason)>500) then
    raise exception 'WAREHOUSE_DEACTIVATION_REASON_REQUIRED' using errcode='P0001';
  end if;
  select w.* into v_warehouse from public.inventory_warehouses w
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_warehouse_id for update;
  if not found then raise exception 'STOCK_WAREHOUSE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_warehouse.is_active=p_is_active then return query select v_warehouse.id,v_warehouse.is_active,true; return; end if;

  if not p_is_active then
    if exists(
      select 1 from (
        select m.item_id,
          sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
            then m.quantity else -m.quantity end) as qty,
          sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
            then m.total_cost_amount else -m.total_cost_amount end) as value
        from public.inventory_stock_movements m
        where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.warehouse_id=p_warehouse_id
        group by m.item_id
      ) balances where balances.qty<>0 or balances.value<>0
    ) then raise exception 'WAREHOUSE_HAS_STOCK' using errcode='P0001'; end if;
    if exists(
      select 1 from public.supplier_purchases p
      where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.warehouse_id=p_warehouse_id
        and p.status in ('draft','confirmed','partially_received')
    ) then raise exception 'WAREHOUSE_HAS_OPEN_PURCHASE' using errcode='P0001'; end if;
  end if;

  select u.platform_role into v_platform_role from public.users u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;
  update public.inventory_warehouses w set is_active=p_is_active,updated_at=now()
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_warehouse_id returning w.* into v_warehouse;
  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_warehouse',v_warehouse.id::text,
    case when p_is_active then 'reactivate' else 'deactivate' end,
    jsonb_build_object('isActive',not p_is_active),jsonb_build_object('isActive',p_is_active),
    jsonb_build_object('reason',v_reason,'historicalRowsPreserved',true)
  );
  return query select v_warehouse.id,v_warehouse.is_active,false;
end;
$$;

revoke all on function public.powerhub_inventory_update_item(bigint,bigint,bigint,bigint,text,text,text,text,numeric,text,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_set_item_active(bigint,bigint,bigint,bigint,boolean,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_update_supplier(bigint,bigint,bigint,bigint,text,text,text,text,text,text,text,integer,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_set_supplier_active(bigint,bigint,bigint,bigint,boolean,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_update_warehouse(bigint,bigint,bigint,bigint,text,text,text) from public,anon,authenticated;
revoke all on function public.powerhub_inventory_set_warehouse_active(bigint,bigint,bigint,bigint,boolean,text) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_update_item(bigint,bigint,bigint,bigint,text,text,text,text,numeric,text,text) to service_role;
grant execute on function public.powerhub_inventory_set_item_active(bigint,bigint,bigint,bigint,boolean,text) to service_role;
grant execute on function public.powerhub_inventory_update_supplier(bigint,bigint,bigint,bigint,text,text,text,text,text,text,text,integer,text) to service_role;
grant execute on function public.powerhub_inventory_set_supplier_active(bigint,bigint,bigint,bigint,boolean,text) to service_role;
grant execute on function public.powerhub_inventory_update_warehouse(bigint,bigint,bigint,bigint,text,text,text) to service_role;
grant execute on function public.powerhub_inventory_set_warehouse_active(bigint,bigint,bigint,bigint,boolean,text) to service_role;
