-- Give each physical stock location an explicit type and, for generator tanks, a
-- tenant/site-safe relationship to its generator. Existing warehouses remain branch warehouses.
create unique index if not exists generators_tenant_site_id_unique_idx
  on public.generators(tenant_id,site_id,id);

alter table public.inventory_warehouses
  add column if not exists location_type text not null default 'branch_warehouse',
  add column if not exists generator_id bigint;

alter table public.inventory_warehouses
  drop constraint if exists inventory_warehouses_location_type_ck;
alter table public.inventory_warehouses
  add constraint inventory_warehouses_location_type_ck
  check (location_type in ('central_warehouse','branch_warehouse','fixed_fuel_tank','generator_fuel_tank'));

alter table public.inventory_warehouses
  drop constraint if exists inventory_warehouses_location_generator_ck;
alter table public.inventory_warehouses
  add constraint inventory_warehouses_location_generator_ck
  check (
    (location_type='generator_fuel_tank' and generator_id is not null)
    or (location_type<>'generator_fuel_tank' and generator_id is null)
  );

alter table public.inventory_warehouses
  drop constraint if exists inventory_warehouses_generator_site_tenant_fk;
alter table public.inventory_warehouses
  add constraint inventory_warehouses_generator_site_tenant_fk
  foreign key (tenant_id,site_id,generator_id)
  references public.generators(tenant_id,site_id,id) on delete restrict;

create index if not exists inventory_warehouses_generator_location_idx
  on public.inventory_warehouses(tenant_id,site_id,generator_id)
  where generator_id is not null;

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

  select coalesce(u.platform_role,'tenant_user') into v_platform_role
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
  select coalesce(u.platform_role,'tenant_user') into v_platform_role
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

revoke all on function public.powerhub_inventory_create_warehouse_with_location(bigint,bigint,bigint,text,text,text,text,bigint)
  from public,anon,authenticated;
revoke all on function public.powerhub_inventory_update_warehouse_with_location(bigint,bigint,bigint,bigint,text,text,text,text,bigint)
  from public,anon,authenticated;
grant execute on function public.powerhub_inventory_create_warehouse_with_location(bigint,bigint,bigint,text,text,text,text,bigint)
  to service_role;
grant execute on function public.powerhub_inventory_update_warehouse_with_location(bigint,bigint,bigint,bigint,text,text,text,text,bigint)
  to service_role;
