alter table public.offline_sync_operations
  drop constraint if exists offline_sync_operations_operation_type_check;

alter table public.offline_sync_operations
  add constraint offline_sync_operations_operation_type_check
  check (operation_type = any (array[
    'subscriber_create','subscriber_update','generator_create','generator_update',
    'invoice_issue','payment_create','account_movement_create','account_transfer_create',
    'expense_create','employee_create','site_create'
  ]::text[]));

create or replace function public.powerhub_create_site_online(
  p_tenant_id bigint,p_user_id bigint,p_name text,p_code text,p_city text,p_address text,p_client_operation_id text
)
returns table(site_id bigint,replayed boolean)
language plpgsql
set search_path=public,pg_temp
as $$
declare v_operation public.offline_sync_operations%rowtype; v_id bigint;
begin
  if nullif(btrim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('site-create:'||p_user_id||':'||p_client_operation_id)::bigint);
  select * into v_operation from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
  if found then
    if v_operation.operation_type<>'site_create'
       or v_operation.tenant_id<>p_tenant_id
       or v_operation.response->>'name'<>btrim(p_name)
       or v_operation.response->>'code'<>btrim(p_code)
       or coalesce(v_operation.response->>'city','')<>coalesce(nullif(btrim(p_city),''),'')
       or coalesce(v_operation.response->>'address','')<>coalesce(nullif(btrim(p_address),''),'')
    then raise exception 'SITE_OPERATION_CONFLICT'; end if;
    return query select (v_operation.response->>'siteId')::bigint,true;
    return;
  end if;

  select s.site_id into v_id from public.powerhub_create_site(
    p_tenant_id,p_user_id,p_name,p_code,p_city,p_address
  ) s;

  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
  ) values (
    p_tenant_id,v_id,p_user_id,p_client_operation_id,'site_create','site',v_id,
    jsonb_build_object(
      'siteId',v_id,'name',btrim(p_name),'code',btrim(p_code),
      'city',nullif(btrim(p_city),''),'address',nullif(btrim(p_address),'')
    )
  );

  return query select v_id,false;
end;
$$;

revoke execute on function public.powerhub_create_site_online(bigint,bigint,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_site_online(bigint,bigint,text,text,text,text,text) to service_role;
