-- Consolidated source-of-truth migration for operational retry contracts.
alter table public.offline_sync_operations drop constraint if exists offline_sync_operations_operation_type_check;
alter table public.offline_sync_operations add constraint offline_sync_operations_operation_type_check
check (operation_type = any (array[
  'subscriber_create','subscriber_update','generator_create','generator_update',
  'invoice_issue','payment_create','account_movement_create','account_transfer_create',
  'expense_create','employee_create','site_create','collector_session_open','tariff_create'
]::text[]));

create or replace function public.powerhub_open_collector_session(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_opening_cash numeric,p_notes text,p_client_operation_id text
) returns table(session_id bigint,replayed boolean)
language plpgsql set search_path=public,pg_temp as $$
declare v_session_id bigint; v_platform_role text; v_op public.offline_sync_operations%rowtype;
begin
  if p_opening_cash < 0 then raise exception 'INVALID_OPENING_CASH'; end if;
  if nullif(btrim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('collector-session-op:'||p_user_id||':'||p_client_operation_id)::bigint);
  select * into v_op from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
  if found then
    if v_op.operation_type<>'collector_session_open' or v_op.tenant_id<>p_tenant_id or v_op.site_id<>p_site_id
       or coalesce(v_op.response->>'openingCash','')<>p_opening_cash::text
       or coalesce(v_op.response->>'notes','')<>coalesce(p_notes,'')
    then raise exception 'COLLECTOR_SESSION_OPERATION_CONFLICT'; end if;
    return query select (v_op.response->>'sessionId')::bigint,true; return;
  end if;
  perform pg_advisory_xact_lock(hashtext('collector-session:'||p_site_id::text||':'||p_user_id::text)::bigint);
  if exists(select 1 from public.collector_sessions where tenant_id=p_tenant_id and site_id=p_site_id and collector_user_id=p_user_id and status='open')
    then raise exception 'COLLECTOR_SESSION_EXISTS'; end if;
  insert into public.collector_sessions(tenant_id,site_id,collector_user_id,opening_cash,notes)
    values(p_tenant_id,p_site_id,p_user_id,p_opening_cash,p_notes) returning id into v_session_id;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'collector_session',v_session_id::text,'open',jsonb_build_object('openingCash',p_opening_cash));
  insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
    values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'collector_session_open','collector_session',v_session_id,
      jsonb_build_object('sessionId',v_session_id,'openingCash',p_opening_cash::text,'notes',coalesce(p_notes,'')));
  return query select v_session_id,false;
end; $$;

create or replace function public.powerhub_create_tariff_idempotent(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_name text,p_code text,
  p_price_per_kwh numeric,p_fixed_fee numeric,p_tax_rate numeric,p_client_operation_id text
) returns table(tariff_id bigint,replayed boolean)
language plpgsql set search_path=public,pg_temp as $$
declare v_id bigint; v_op public.offline_sync_operations%rowtype;
begin
  if nullif(btrim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('tariff-create:'||p_user_id||':'||p_client_operation_id)::bigint);
  select * into v_op from public.offline_sync_operations where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
  if found then
    if v_op.operation_type<>'tariff_create' or v_op.tenant_id<>p_tenant_id or v_op.site_id<>p_site_id
       or v_op.response->>'name'<>btrim(p_name) or v_op.response->>'code'<>upper(btrim(p_code))
       or (v_op.response->>'pricePerKwh')::numeric<>p_price_per_kwh
       or (v_op.response->>'fixedFee')::numeric<>p_fixed_fee
       or (v_op.response->>'taxRate')::numeric<>p_tax_rate
    then raise exception 'TARIFF_OPERATION_CONFLICT'; end if;
    return query select (v_op.response->>'tariffId')::bigint,true; return;
  end if;
  insert into public.tariffs(tenant_id,site_id,name,code,price_per_kwh,fixed_fee,tax_rate)
    values(p_tenant_id,p_site_id,btrim(p_name),upper(btrim(p_code)),p_price_per_kwh,p_fixed_fee,p_tax_rate) returning id into v_id;
  insert into public.offline_sync_operations(tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response)
    values(p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'tariff_create','tariff',v_id,
      jsonb_build_object('tariffId',v_id,'name',btrim(p_name),'code',upper(btrim(p_code)),
      'pricePerKwh',p_price_per_kwh,'fixedFee',p_fixed_fee,'taxRate',p_tax_rate));
  return query select v_id,false;
exception when unique_violation then raise exception 'TARIFF_CODE_EXISTS';
end; $$;

revoke execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text) from public,anon,authenticated;
revoke execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text) to service_role;
grant execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text,text) to service_role;
revoke execute on function public.powerhub_create_tariff_idempotent(bigint,bigint,bigint,text,text,numeric,numeric,numeric,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_tariff_idempotent(bigint,bigint,bigint,text,text,numeric,numeric,numeric,text) to service_role;