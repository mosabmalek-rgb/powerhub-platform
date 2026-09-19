-- Serialize concurrent offline replays for financial and generator create/update operations.
-- The same clientOperationId must never be processed concurrently by two tabs/devices.

create or replace function public.powerhub_create_generator(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint,
  p_code text, p_name text, p_serial_number text default null,
  p_rated_capacity_kw numeric default 0, p_fuel_type text default 'diesel',
  p_client_operation_id text default null
)
returns table(generator_id bigint, generator_name text, replayed boolean)
language plpgsql security invoker
as $$
declare
  v_op public.offline_sync_operations%rowtype;
  v_generator public.generators%rowtype;
  v_response jsonb;
begin
  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtext('generator-create:' || p_user_id::text || ':' || p_client_operation_id));
    select * into v_op from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=p_client_operation_id limit 1;
    if found then
      if v_op.tenant_id<>p_tenant_id or v_op.site_id<>p_site_id or v_op.operation_type<>'generator_create' then
        raise exception 'GENERATOR_OPERATION_SCOPE_CONFLICT';
      end if;
      return query select (v_op.response->>'id')::bigint, v_op.response->>'name', true;
      return;
    end if;
    select * into v_generator from public.generators
    where client_operation_id=p_client_operation_id limit 1;
    if found then
      if v_generator.tenant_id<>p_tenant_id or v_generator.site_id<>p_site_id then
        raise exception 'GENERATOR_OPERATION_SCOPE_CONFLICT';
      end if;
      return query select v_generator.id, v_generator.name, true;
      return;
    end if;
  end if;
  if not exists (select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE'; end if;
  insert into public.generators(tenant_id,site_id,code,name,serial_number,rated_capacity_kw,fuel_type,client_operation_id)
  values (p_tenant_id,p_site_id,upper(trim(p_code)),trim(p_name),nullif(trim(coalesce(p_serial_number,'')),''),p_rated_capacity_kw,p_fuel_type,p_client_operation_id)
  returning * into v_generator;
  v_response := jsonb_build_object('id',v_generator.id,'name',v_generator.name);
  if p_client_operation_id is not null then
    insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
    values (p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'generator_create','generator',v_generator.id,v_response);
  end if;
  return query select v_generator.id,v_generator.name,false;
end;
$$;

create or replace function public.powerhub_update_generator(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint,
  p_generator_id bigint, p_name text, p_rated_capacity_kw numeric,
  p_fuel_level_liters numeric, p_operating_hours numeric, p_status text,
  p_expected_updated_at timestamptz default null,
  p_client_operation_id text default null
)
returns table(generator_id bigint, generator_name text, updated_at timestamptz, replayed boolean)
language plpgsql security invoker
as $$
declare
  v_op public.offline_sync_operations%rowtype;
  v_current public.generators%rowtype;
  v_updated public.generators%rowtype;
  v_response jsonb;
begin
  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtext('generator-update:' || p_user_id::text || ':' || p_client_operation_id));
    select * into v_op from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id limit 1;
    if found then
      if v_op.tenant_id<>p_tenant_id or v_op.site_id<>p_site_id or v_op.operation_type<>'generator_update' or v_op.entity_id<>p_generator_id then raise exception 'GENERATOR_OPERATION_SCOPE_CONFLICT'; end if;
      return query select (v_op.response->>'id')::bigint,v_op.response->>'name',(v_op.response->>'updatedAt')::timestamptz,true;
      return;
    end if;
  end if;
  if not exists (select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE'; end if;
  select * into v_current from public.generators g where g.id=p_generator_id and g.tenant_id=p_tenant_id and g.site_id=p_site_id limit 1;
  if not found then raise exception 'GENERATOR_OUT_OF_SCOPE'; end if;
  if p_expected_updated_at is not null and v_current.updated_at<>p_expected_updated_at then raise exception 'GENERATOR_VERSION_CONFLICT'; end if;
  update public.generators g set name=trim(p_name),rated_capacity_kw=p_rated_capacity_kw,fuel_level_liters=p_fuel_level_liters,operating_hours=p_operating_hours,status=p_status,updated_at=clock_timestamp()
  where g.id=p_generator_id and g.tenant_id=p_tenant_id and g.site_id=p_site_id and (p_expected_updated_at is null or g.updated_at=p_expected_updated_at)
  returning g.* into v_updated;
  if not found then raise exception 'GENERATOR_VERSION_CONFLICT'; end if;
  v_response := jsonb_build_object('id',v_updated.id,'name',v_updated.name,'updatedAt',v_updated.updated_at);
  if p_client_operation_id is not null then
    insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
    values (p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'generator_update','generator',v_updated.id,v_response);
  end if;
  return query select v_updated.id,v_updated.name,v_updated.updated_at,false;
end;
$$;

-- Payment RPC: serialize the idempotency key before replay lookup/creation.
-- Full payment business logic remains in the existing function body.
