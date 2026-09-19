-- Ensure generator operation replay is keyed to the complete operation payload, not a partial field.
create or replace function public.powerhub_create_generator_online(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_code text,p_name text,
  p_serial_number text,p_rated_capacity_kw numeric,p_fuel_type text,p_client_operation_id text
)
returns table(generator_id bigint,replayed boolean)
language plpgsql
set search_path=public,pg_temp
as $$
declare v_operation public.offline_sync_operations%rowtype; v_id bigint;
begin
 if nullif(btrim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtext('generator-create:'||p_user_id||':'||p_client_operation_id)::bigint);
 select * into v_operation from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
 if found then
   if v_operation.operation_type<>'generator_create'
      or v_operation.tenant_id<>p_tenant_id
      or v_operation.site_id<>p_site_id
      or v_operation.response->>'code'<>upper(trim(p_code))
      or v_operation.response->>'name'<>trim(p_name)
      or coalesce(v_operation.response->>'serialNumber','')<>coalesce(nullif(trim(coalesce(p_serial_number,'')),''),'')
      or (v_operation.response->>'ratedCapacityKw')::numeric is distinct from p_rated_capacity_kw
      or v_operation.response->>'fuelType'<>p_fuel_type
   then raise exception 'GENERATOR_OPERATION_CONFLICT'; end if;
   return query select (v_operation.response->>'generatorId')::bigint,true; return;
 end if;
 if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status<>'archived') then raise exception 'SITE_OUT_OF_SCOPE'; end if;
 insert into public.generators(tenant_id,site_id,code,name,serial_number,rated_capacity_kw,fuel_type)
 values(p_tenant_id,p_site_id,upper(trim(p_code)),trim(p_name),nullif(trim(coalesce(p_serial_number,'')),''),p_rated_capacity_kw,p_fuel_type)
 returning id into v_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,after_data)
 values(p_tenant_id,p_site_id,p_user_id,'generator',v_id::text,'create',
   jsonb_build_object('code',upper(trim(p_code)),'name',trim(p_name),
     'serialNumber',nullif(trim(coalesce(p_serial_number,'')),''),
     'ratedCapacityKw',p_rated_capacity_kw,'fuelType',p_fuel_type,
     'clientOperationId',p_client_operation_id));
 insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
 values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'generator_create','generator',v_id,
   jsonb_build_object('generatorId',v_id,'code',upper(trim(p_code)),'name',trim(p_name),
     'serialNumber',nullif(trim(coalesce(p_serial_number,'')),''),
     'ratedCapacityKw',p_rated_capacity_kw,'fuelType',p_fuel_type));
 return query select v_id,false;
end;
$$;

create or replace function public.powerhub_update_generator_online(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_generator_id bigint,p_name text,
 p_rated_capacity_kw numeric,p_fuel_level_liters numeric,p_operating_hours numeric,p_status text,
 p_expected_updated_at timestamptz,p_client_operation_id text
)
returns table(generator_id bigint,updated_at timestamptz,replayed boolean)
language plpgsql
set search_path=public,pg_temp
as $$
declare v_operation public.offline_sync_operations%rowtype; v_updated timestamptz;
begin
 if nullif(btrim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtext('generator-update:'||p_user_id||':'||p_client_operation_id)::bigint);
 select * into v_operation from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
 if found then
   if v_operation.operation_type<>'generator_update'
      or v_operation.tenant_id<>p_tenant_id
      or v_operation.site_id<>p_site_id
      or (v_operation.response->>'generatorId')::bigint<>p_generator_id
      or v_operation.response->>'name'<>trim(p_name)
      or (v_operation.response->>'ratedCapacityKw')::numeric is distinct from p_rated_capacity_kw
      or (v_operation.response->>'fuelLevelLiters')::numeric is distinct from p_fuel_level_liters
      or (v_operation.response->>'operatingHours')::numeric is distinct from p_operating_hours
      or v_operation.response->>'status'<>p_status
      or v_operation.response->>'expectedUpdatedAt'<>coalesce(p_expected_updated_at::text,'')
   then raise exception 'GENERATOR_OPERATION_CONFLICT'; end if;
   return query select (v_operation.response->>'generatorId')::bigint,(v_operation.response->>'updatedAt')::timestamptz,true; return;
 end if;
 if not exists(select 1 from public.generators where id=p_generator_id and tenant_id=p_tenant_id and site_id=p_site_id) then raise exception 'GENERATOR_OUT_OF_SCOPE'; end if;
 update public.generators
 set name=trim(p_name),rated_capacity_kw=p_rated_capacity_kw,fuel_level_liters=p_fuel_level_liters,
     operating_hours=p_operating_hours,status=p_status,updated_at=clock_timestamp()
 where id=p_generator_id and tenant_id=p_tenant_id and site_id=p_site_id and updated_at=p_expected_updated_at
 returning updated_at into v_updated;
 if v_updated is null then raise exception 'GENERATOR_VERSION_CONFLICT'; end if;
 insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,after_data)
 values(p_tenant_id,p_site_id,p_user_id,'generator',p_generator_id::text,'update',
   jsonb_build_object('clientOperationId',p_client_operation_id,'expectedUpdatedAt',p_expected_updated_at,
     'name',trim(p_name),'ratedCapacityKw',p_rated_capacity_kw,'fuelLevelLiters',p_fuel_level_liters,
     'operatingHours',p_operating_hours,'status',p_status));
 insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
 values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'generator_update','generator',p_generator_id,
   jsonb_build_object('generatorId',p_generator_id,'updatedAt',v_updated,'expectedUpdatedAt',p_expected_updated_at,
     'name',trim(p_name),'ratedCapacityKw',p_rated_capacity_kw,'fuelLevelLiters',p_fuel_level_liters,
     'operatingHours',p_operating_hours,'status',p_status));
 return query select p_generator_id,v_updated,false;
end;
$$;

revoke execute on function public.powerhub_create_generator_online(bigint,bigint,bigint,text,text,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_generator_online(bigint,bigint,bigint,text,text,text,numeric,text,text) to service_role;
revoke execute on function public.powerhub_update_generator_online(bigint,bigint,bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.powerhub_update_generator_online(bigint,bigint,bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text) to service_role;
