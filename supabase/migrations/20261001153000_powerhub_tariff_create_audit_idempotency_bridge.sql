-- Reconcile tariff creation with the idempotent operation contract and audit boundary.
create or replace function public.powerhub_create_tariff_idempotent(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_name text,p_code text,
  p_price_per_kwh numeric,p_fixed_fee numeric,p_tax_rate numeric,p_client_operation_id text
)
returns table(tariff_id bigint,replayed boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_id bigint;
  v_op public.offline_sync_operations%rowtype;
  v_platform_role text;
begin
  if nullif(btrim(p_client_operation_id),'') is null then
    raise exception 'CLIENT_OPERATION_REQUIRED';
  end if;
  if p_price_per_kwh < 0 or p_fixed_fee < 0 or p_tax_rate < 0 or p_tax_rate > 100 then
    raise exception 'INVALID_TARIFF_VALUES';
  end if;

  perform pg_advisory_xact_lock(hashtext('tariff-create:'||p_user_id||':'||p_client_operation_id)::bigint);

  select * into v_op
  from public.offline_sync_operations
  where user_id=p_user_id and client_operation_id=p_client_operation_id
  for update;

  if found then
    if v_op.operation_type<>'tariff_create'
       or v_op.tenant_id<>p_tenant_id
       or v_op.site_id<>p_site_id
       or v_op.response->>'name'<>btrim(p_name)
       or v_op.response->>'code'<>upper(btrim(p_code))
       or (v_op.response->>'pricePerKwh')::numeric<>p_price_per_kwh
       or (v_op.response->>'fixedFee')::numeric<>p_fixed_fee
       or (v_op.response->>'taxRate')::numeric<>p_tax_rate
    then
      raise exception 'TARIFF_OPERATION_CONFLICT';
    end if;
    return query select (v_op.response->>'tariffId')::bigint,true;
    return;
  end if;

  insert into public.tariffs(tenant_id,site_id,name,code,price_per_kwh,fixed_fee,tax_rate)
  values(p_tenant_id,p_site_id,btrim(p_name),upper(btrim(p_code)),p_price_per_kwh,p_fixed_fee,p_tax_rate)
  returning id into v_id;

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
  ) values(
    p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'tariff_create','tariff',v_id,
    jsonb_build_object(
      'tariffId',v_id,'name',btrim(p_name),'code',upper(btrim(p_code)),
      'pricePerKwh',p_price_per_kwh,'fixedFee',p_fixed_fee,'taxRate',p_tax_rate
    )
  );

  select platform_role into v_platform_role from public.users where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'tariff',v_id::text,'create',
    jsonb_build_object(
      'name',btrim(p_name),'code',upper(btrim(p_code)),'pricePerKwh',p_price_per_kwh,
      'fixedFee',p_fixed_fee,'taxRate',p_tax_rate,'clientOperationId',p_client_operation_id
    )
  );

  return query select v_id,false;
exception when unique_violation then
  raise exception 'TARIFF_CODE_EXISTS';
end;
$$;

revoke execute on function public.powerhub_create_tariff_idempotent(bigint,bigint,bigint,text,text,numeric,numeric,numeric,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_tariff_idempotent(bigint,bigint,bigint,text,text,numeric,numeric,numeric,text) to service_role;
