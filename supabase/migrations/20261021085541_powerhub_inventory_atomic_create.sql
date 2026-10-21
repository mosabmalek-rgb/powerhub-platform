-- Atomic create operations for inventory catalog, suppliers, and site warehouses.
-- Each operation records its audit entry in the same transaction as the new row.
-- Functions are callable only by the trusted service_role; the server performs the
-- per-user capability and site/tenant access checks before calling them.

create or replace function public.powerhub_inventory_create_item(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_sku text,
  p_name text,
  p_category text,
  p_base_unit text,
  p_reorder_point numeric,
  p_specification text,
  p_notes text
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
  v_platform_role text;
begin
  perform 1 from public.sites as s where s.id=p_site_id and s.tenant_id=p_tenant_id;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role from public.users as u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.inventory_items(
    tenant_id,sku,name,category,base_unit,reorder_point,specification,notes,created_by_user_id
  ) values (
    p_tenant_id,nullif(btrim(p_sku),''),btrim(p_name),p_category,p_base_unit,
    p_reorder_point,nullif(btrim(p_specification),''),nullif(btrim(p_notes),''),p_user_id
  ) returning * into v_item;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_item',v_item.id::text,'create',
    jsonb_build_object('sku',v_item.sku,'name',v_item.name,'category',v_item.category,'baseUnit',v_item.base_unit)
  );

  return query select v_item.id,v_item.tenant_id,v_item.sku,v_item.name,v_item.category,v_item.base_unit,
    v_item.reorder_point,v_item.specification,v_item.notes,v_item.is_active,v_item.created_at,v_item.updated_at;
end;
$$;

create or replace function public.powerhub_inventory_create_supplier(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_supplier_code text,
  p_name text,
  p_contact_name text,
  p_phone text,
  p_email text,
  p_address text,
  p_tax_number text,
  p_default_payment_terms_days integer,
  p_notes text
)
returns table(
  id bigint, tenant_id bigint, supplier_code text, name text, contact_name text, phone text,
  email text, address text, tax_number text, default_payment_terms_days integer, notes text,
  is_active boolean, created_at timestamptz, updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_supplier public.suppliers%rowtype;
  v_platform_role text;
begin
  perform 1 from public.sites as s where s.id=p_site_id and s.tenant_id=p_tenant_id;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role from public.users as u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.suppliers(
    tenant_id,supplier_code,name,contact_name,phone,email,address,tax_number,
    default_payment_terms_days,notes,created_by_user_id
  ) values (
    p_tenant_id,nullif(btrim(p_supplier_code),''),btrim(p_name),nullif(btrim(p_contact_name),''),
    nullif(btrim(p_phone),''),nullif(btrim(p_email),''),nullif(btrim(p_address),''),
    nullif(btrim(p_tax_number),''),p_default_payment_terms_days,nullif(btrim(p_notes),''),p_user_id
  ) returning * into v_supplier;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'supplier',v_supplier.id::text,'create',
    jsonb_build_object('supplierCode',v_supplier.supplier_code,'name',v_supplier.name,'phone',v_supplier.phone)
  );

  return query select v_supplier.id,v_supplier.tenant_id,v_supplier.supplier_code,v_supplier.name,
    v_supplier.contact_name,v_supplier.phone,v_supplier.email,v_supplier.address,v_supplier.tax_number,
    v_supplier.default_payment_terms_days,v_supplier.notes,v_supplier.is_active,v_supplier.created_at,v_supplier.updated_at;
end;
$$;

create or replace function public.powerhub_inventory_create_warehouse(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_code text,
  p_name text,
  p_notes text
)
returns table(
  id bigint, tenant_id bigint, site_id bigint, code text, name text, notes text,
  is_active boolean, created_at timestamptz, updated_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_warehouse public.inventory_warehouses%rowtype;
  v_platform_role text;
begin
  perform 1 from public.sites as s where s.id=p_site_id and s.tenant_id=p_tenant_id;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select u.platform_role into v_platform_role from public.users as u where u.id=p_user_id;
  if not found then raise exception 'ACTOR_NOT_FOUND' using errcode='P0001'; end if;

  insert into public.inventory_warehouses(tenant_id,site_id,code,name,notes,created_by_user_id)
  values (p_tenant_id,p_site_id,btrim(p_code),btrim(p_name),nullif(btrim(p_notes),''),p_user_id)
  returning * into v_warehouse;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'inventory_warehouse',v_warehouse.id::text,'create',
    jsonb_build_object('code',v_warehouse.code,'name',v_warehouse.name)
  );

  return query select v_warehouse.id,v_warehouse.tenant_id,v_warehouse.site_id,v_warehouse.code,
    v_warehouse.name,v_warehouse.notes,v_warehouse.is_active,v_warehouse.created_at,v_warehouse.updated_at;
end;
$$;

revoke execute on function public.powerhub_inventory_create_item(bigint,bigint,bigint,text,text,text,text,numeric,text,text) from public,anon,authenticated;
revoke execute on function public.powerhub_inventory_create_supplier(bigint,bigint,bigint,text,text,text,text,text,text,text,integer,text) from public,anon,authenticated;
revoke execute on function public.powerhub_inventory_create_warehouse(bigint,bigint,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_inventory_create_item(bigint,bigint,bigint,text,text,text,text,numeric,text,text) to service_role;
grant execute on function public.powerhub_inventory_create_supplier(bigint,bigint,bigint,text,text,text,text,text,text,text,integer,text) to service_role;
grant execute on function public.powerhub_inventory_create_warehouse(bigint,bigint,bigint,text,text,text) to service_role;
