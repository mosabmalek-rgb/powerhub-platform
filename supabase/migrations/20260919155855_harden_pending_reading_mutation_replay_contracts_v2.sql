alter table public.offline_sync_operations
  add column if not exists request_fingerprint text;

alter table public.offline_sync_operations
  drop constraint if exists offline_sync_operations_operation_type_check;

alter table public.offline_sync_operations
  add constraint offline_sync_operations_operation_type_check
  check (operation_type = any (array[
    'subscriber_create','subscriber_update','subscriber_bulk_import','generator_create','generator_update',
    'invoice_issue','payment_create','account_movement_create','account_transfer_create','expense_create',
    'employee_create','site_create','collector_session_open','tariff_create','company_account_create',
    'staff_create','subscription_renew','subscription_update','subscription_quick_upgrade','reading_update','reading_delete'
  ]));

drop function if exists public.powerhub_update_pending_reading(bigint,bigint,bigint,bigint,integer,numeric,timestamptz,text);

create function public.powerhub_update_pending_reading(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_reading_id bigint,p_base_version integer,
  p_reading_value numeric,p_reading_at timestamptz,p_notes text,p_client_operation_id text,p_request_fingerprint text
) returns table(consumption_kwh numeric,updated_at timestamptz,replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp as $function$
declare
  v_reading public.meter_readings%rowtype;
  v_previous_value numeric:=0;
  v_consumption numeric;
  v_updated_at timestamptz;
  v_platform_role text;
  v_operation public.offline_sync_operations%rowtype;
  v_response jsonb;
begin
  if nullif(trim(p_client_operation_id),'') is null or nullif(trim(p_request_fingerprint),'') is null then raise exception 'INVALID_OPERATION_ID'; end if;
  perform pg_advisory_xact_lock(p_reading_id);
  select * into v_operation from public.offline_sync_operations where user_id=p_user_id and client_operation_id=trim(p_client_operation_id) for update;
  if found then
    if v_operation.operation_type<>'reading_update'
       or v_operation.request_fingerprint is distinct from p_request_fingerprint
       or v_operation.tenant_id is distinct from p_tenant_id
       or v_operation.site_id is distinct from p_site_id
       or v_operation.entity_id is distinct from p_reading_id then raise exception 'OPERATION_CONFLICT'; end if;
    v_response:=v_operation.response;
    return query select (v_response->>'consumptionKwh')::numeric,(v_response->>'updatedAt')::timestamptz,true; return;
  end if;

  select r.* into v_reading
  from public.meter_readings r
  join public.subscribers s on s.id=r.subscriber_id
  where r.id=p_reading_id and r.tenant_id=p_tenant_id and s.site_id=p_site_id for update of r;
  if not found then raise exception 'READING_OUT_OF_SCOPE'; end if;
  if v_reading.status<>'pending_review' then raise exception 'READING_NOT_PENDING'; end if;
  if v_reading.version_no<>p_base_version then raise exception 'READING_VERSION_CONFLICT'; end if;

  select coalesce(reading_value,0) into v_previous_value
  from public.meter_readings
  where subscriber_id=v_reading.subscriber_id and status='approved'
  order by reading_at desc limit 1;

  if p_reading_value<v_previous_value then raise exception 'READING_BELOW_PREVIOUS'; end if;
  v_consumption:=p_reading_value-v_previous_value;

  update public.meter_readings
  set reading_value=p_reading_value,reading_at=p_reading_at,previous_reading_value=nullif(v_previous_value,0),
      consumption_kwh=v_consumption,notes=nullif(trim(p_notes),''),version_no=version_no+1
  where id=p_reading_id returning updated_at into v_updated_at;

  select platform_role into v_platform_role from public.users where id=p_user_id;

  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data)
  values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'meter_reading',p_reading_id::text,'update_pending',
    jsonb_build_object('readingValue',v_reading.reading_value,'readingAt',v_reading.reading_at,'notes',v_reading.notes,'versionNo',v_reading.version_no),
    jsonb_build_object('readingValue',p_reading_value,'readingAt',p_reading_at,'notes',nullif(trim(p_notes),''),'consumptionKwh',v_consumption,'versionNo',p_base_version+1)
  );

  v_response:=jsonb_build_object('consumptionKwh',v_consumption,'updatedAt',v_updated_at);

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response,request_fingerprint
  )
  values(
    p_tenant_id,p_site_id,p_user_id,trim(p_client_operation_id),'reading_update','meter_reading',p_reading_id,v_response,p_request_fingerprint
  );

  return query select v_consumption,v_updated_at,false;
end;
$function$;

drop function if exists public.powerhub_delete_pending_reading(bigint,bigint,bigint,bigint,integer);

create function public.powerhub_delete_pending_reading(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_reading_id bigint,p_base_version integer,
  p_client_operation_id text,p_request_fingerprint text
) returns table(deleted_reading_id bigint,replayed boolean)
language plpgsql security invoker set search_path=public,pg_temp as $function$
declare
  v_reading public.meter_readings%rowtype;
  v_platform_role text;
  v_operation public.offline_sync_operations%rowtype;
  v_response jsonb;
begin
  if nullif(trim(p_client_operation_id),'') is null or nullif(trim(p_request_fingerprint),'') is null then raise exception 'INVALID_OPERATION_ID'; end if;
  perform pg_advisory_xact_lock(p_reading_id);

  select * into v_operation from public.offline_sync_operations where user_id=p_user_id and client_operation_id=trim(p_client_operation_id) for update;
  if found then
    if v_operation.operation_type<>'reading_delete'
       or v_operation.request_fingerprint is distinct from p_request_fingerprint
       or v_operation.tenant_id is distinct from p_tenant_id
       or v_operation.site_id is distinct from p_site_id
       or v_operation.entity_id is distinct from p_reading_id then raise exception 'OPERATION_CONFLICT'; end if;
    v_response:=v_operation.response;
    return query select (v_response->>'deletedReadingId')::bigint,true; return;
  end if;

  select r.* into v_reading
  from public.meter_readings r
  join public.subscribers s on s.id=r.subscriber_id
  where r.id=p_reading_id and r.tenant_id=p_tenant_id and s.site_id=p_site_id for update of r;
  if not found then raise exception 'READING_OUT_OF_SCOPE'; end if;
  if v_reading.status<>'pending_review' then raise exception 'READING_NOT_PENDING'; end if;
  if v_reading.version_no<>p_base_version then raise exception 'READING_VERSION_CONFLICT'; end if;

  delete from public.meter_readings where id=p_reading_id;

  select platform_role into v_platform_role from public.users where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data
  )
  values(
    p_tenant_id,p_site_id,p_user_id,v_platform_role,'meter_reading',p_reading_id::text,'delete_pending',
    jsonb_build_object('subscriberId',v_reading.subscriber_id,'readingValue',v_reading.reading_value,'readingAt',v_reading.reading_at,'versionNo',v_reading.version_no)
  );

  v_response:=jsonb_build_object('deletedReadingId',p_reading_id);

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response,request_fingerprint
  )
  values(
    p_tenant_id,p_site_id,p_user_id,trim(p_client_operation_id),'reading_delete','meter_reading',p_reading_id,v_response,p_request_fingerprint
  );

  return query select p_reading_id,false;
end;
$function$;

revoke all on function public.powerhub_update_pending_reading(bigint,bigint,bigint,bigint,integer,numeric,timestamptz,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_update_pending_reading(bigint,bigint,bigint,bigint,integer,numeric,timestamptz,text,text,text) to service_role;

revoke all on function public.powerhub_delete_pending_reading(bigint,bigint,bigint,bigint,integer,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_delete_pending_reading(bigint,bigint,bigint,bigint,integer,text,text) to service_role;
