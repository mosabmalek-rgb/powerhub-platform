-- Final source-of-truth migration for operational retry/idempotency contracts.
-- Safe to re-run: all functions are CREATE OR REPLACE and grants are explicit.

alter table public.offline_sync_operations
  drop constraint if exists offline_sync_operations_operation_type_check;

alter table public.offline_sync_operations
  add constraint offline_sync_operations_operation_type_check
  check (operation_type = any (array[
    'subscriber_create',
    'subscriber_update',
    'generator_create',
    'generator_update',
    'invoice_issue',
    'payment_create',
    'account_movement_create',
    'account_transfer_create',
    'expense_create',
    'employee_create',
    'site_create',
    'collector_session_open',
    'tariff_create'
  ]::text[]));

create or replace function public.powerhub_create_expense(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_generator_id bigint,
  p_category text,p_description text,p_amount numeric,p_reference_no text,
  p_client_operation_id text
)
returns table(expense_id bigint,replayed boolean)
language plpgsql
set search_path=public,pg_temp
as $$
declare
  v_expense_id bigint;
  v_platform_role text;
  v_operation public.offline_sync_operations%rowtype;
  v_operation_key text;
begin
  if p_amount <= 0 then raise exception 'INVALID_EXPENSE_AMOUNT'; end if;
  if p_category not in ('fuel','maintenance','payroll','parts','transport','other') then raise exception 'INVALID_EXPENSE_CATEGORY'; end if;
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status<>'archived') then raise exception 'SITE_OUT_OF_SCOPE'; end if;
  v_operation_key:=nullif(btrim(p_client_operation_id),'');
  if v_operation_key is not null then
    perform pg_advisory_xact_lock(hashtext('expense-create:'||p_user_id::text||':'||v_operation_key)::bigint);
    select * into v_operation from public.offline_sync_operations
      where user_id=p_user_id and client_operation_id=v_operation_key for update;
    if found then
      if v_operation.tenant_id<>p_tenant_id or v_operation.site_id<>p_site_id
         or v_operation.operation_type<>'expense_create'
         or v_operation.response->>'category'<>p_category
         or v_operation.response->>'description'<>p_description
         or (v_operation.response->>'amount')::numeric is distinct from p_amount
         or coalesce(v_operation.response->>'generatorId','')<>coalesce(p_generator_id::text,'')
         or coalesce(v_operation.response->>'referenceNo','')<>coalesce(p_reference_no,'')
      then raise exception 'EXPENSE_OPERATION_CONFLICT'; end if;
      return query select (v_operation.response->>'expenseId')::bigint,true;
      return;
    end if;
  end if;
  perform pg_advisory_xact_lock(p_site_id);
  perform public.powerhub_assert_financial_period_open(p_tenant_id,p_site_id,now());
  if p_generator_id is not null and not exists(
    select 1 from public.generators where id=p_generator_id and tenant_id=p_tenant_id and site_id=p_site_id
  ) then raise exception 'GENERATOR_OUT_OF_SCOPE'; end if;
  insert into public.expenses(tenant_id,site_id,generator_id,category,description,amount,reference_no,created_by_user_id)
  values(p_tenant_id,p_site_id,p_generator_id,p_category,p_description,p_amount,p_reference_no,p_user_id)
  returning id into v_expense_id;
  select platform_role into v_platform_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(p_tenant_id,p_site_id,p_user_id,v_platform_role,'expense',v_expense_id::text,'create',
    jsonb_build_object('generatorId',p_generator_id,'category',p_category,'description',p_description,
      'amount',p_amount,'referenceNo',p_reference_no,'clientOperationId',v_operation_key));
  if v_operation_key is not null then
    insert into public.offline_sync_operations(
      tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
    )
    values(
      p_tenant_id,p_site_id,p_user_id,v_operation_key,'expense_create','expense',v_expense_id,
      jsonb_build_object('expenseId',v_expense_id,'generatorId',p_generator_id,'category',p_category,
        'description',p_description,'amount',p_amount,'referenceNo',p_reference_no)
    );
  end if;
  return query select v_expense_id,false;
end;
$$;

create or replace function public.powerhub_create_expense(
  p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_generator_id bigint,
  p_category text,p_description text,p_amount numeric,p_reference_no text
)
returns table(expense_id bigint)
language plpgsql
set search_path=public,pg_temp
as $$
declare v_expense_id bigint;
begin
  select x.expense_id into v_expense_id
  from public.powerhub_create_expense(
    p_tenant_id,p_site_id,p_user_id,p_generator_id,p_category,p_description,p_amount,p_reference_no,null
  ) x;
  return query select v_expense_id;
end;
$$;

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
  perform pg_advisory_xact_lock(hashtext('generator-create:'||p_user_id::text||':'||p_client_operation_id)::bigint);
  select * into v_operation from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
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
  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
  )
  values(
    p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'generator_create','generator',v_id,
    jsonb_build_object('generatorId',v_id,'code',upper(trim(p_code)),'name',trim(p_name),
      'serialNumber',nullif(trim(coalesce(p_serial_number,'')),''),
      'ratedCapacityKw',p_rated_capacity_kw,'fuelType',p_fuel_type)
  );
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
  perform pg_advisory_xact_lock(hashtext('generator-update:'||p_user_id::text||':'||p_client_operation_id)::bigint);
  select * into v_operation from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
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
  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
  )
  values(
    p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'generator_update','generator',p_generator_id,
    jsonb_build_object('generatorId',p_generator_id,'updatedAt',v_updated,'expectedUpdatedAt',p_expected_updated_at,
      'name',trim(p_name),'ratedCapacityKw',p_rated_capacity_kw,'fuelLevelLiters',p_fuel_level_liters,
      'operatingHours',p_operating_hours,'status',p_status)
  );
  return query select p_generator_id,v_updated,false;
end;
$$;

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
    if v_operation.operation_type<>'site_create' or v_operation.tenant_id<>p_tenant_id
       or v_operation.response->>'name'<>btrim(p_name) or v_operation.response->>'code'<>btrim(p_code)
       or coalesce(v_operation.response->>'city','')<>coalesce(nullif(btrim(p_city),''),'')
       or coalesce(v_operation.response->>'address','')<>coalesce(nullif(btrim(p_address),''),'')
    then raise exception 'SITE_OPERATION_CONFLICT'; end if;
    return query select (v_operation.response->>'siteId')::bigint,true; return;
  end if;
  select s.site_id into v_id from public.powerhub_create_site(p_tenant_id,p_user_id,p_name,p_code,p_city,p_address) s;
  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
  ) values(
    p_tenant_id,v_id,p_user_id,p_client_operation_id,'site_create','site',v_id,
    jsonb_build_object('siteId',v_id,'name',btrim(p_name),'code',btrim(p_code),
      'city',nullif(btrim(p_city),''),'address',nullif(btrim(p_address),''))
  );
  return query select v_id,false;
end;
$$;

create or replace function public.powerhub_create_employee_online(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_full_name text,p_identity_no text,
 p_phone text,p_job_title text,p_employment_status text,p_contract_type text,p_base_wage numeric,
 p_hire_date date,p_notes text,p_linked_user_id bigint,p_client_operation_id text
)
returns table(employee_id bigint,replayed boolean)
language plpgsql
set search_path=public,pg_temp
as $$
declare v_operation public.offline_sync_operations%rowtype; v_id bigint;
begin
  if nullif(btrim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('employee-create:'||p_user_id||':'||p_client_operation_id)::bigint);
  select * into v_operation from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
  if found then
    if v_operation.operation_type<>'employee_create'
      or v_operation.tenant_id<>p_tenant_id or v_operation.site_id<>p_site_id
      or v_operation.response->>'fullName'<>btrim(p_full_name)
      or coalesce(v_operation.response->>'identityNo','')<>coalesce(nullif(btrim(p_identity_no),''),'')
      or coalesce(v_operation.response->>'phone','')<>coalesce(nullif(btrim(p_phone),''),'')
      or v_operation.response->>'jobTitle'<>p_job_title
      or v_operation.response->>'employmentStatus'<>p_employment_status
      or v_operation.response->>'contractType'<>p_contract_type
      or (v_operation.response->>'baseWage')::numeric is distinct from p_base_wage
      or coalesce(v_operation.response->>'hireDate','')<>coalesce(p_hire_date::text,'')
      or coalesce(v_operation.response->>'notes','')<>coalesce(nullif(btrim(p_notes),''),'')
      or (v_operation.response->>'linkedUserId')::bigint is distinct from p_linked_user_id
    then raise exception 'EMPLOYEE_OPERATION_CONFLICT'; end if;
    return query select (v_operation.response->>'employeeId')::bigint,true; return;
  end if;
  select e.employee_id into v_id from public.powerhub_create_employee(
    p_tenant_id,p_site_id,p_user_id,p_full_name,p_identity_no,p_phone,p_job_title,
    p_employment_status,p_contract_type,p_base_wage,p_hire_date,p_notes,p_linked_user_id
  ) e;
  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
  ) values(
    p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'employee_create','employee',v_id,
    jsonb_build_object('employeeId',v_id,'fullName',btrim(p_full_name),
      'identityNo',nullif(btrim(p_identity_no),''),'phone',nullif(btrim(p_phone),''),
      'jobTitle',p_job_title,'employmentStatus',p_employment_status,'contractType',p_contract_type,
      'baseWage',p_base_wage,'hireDate',p_hire_date,'notes',nullif(btrim(p_notes),''),
      'linkedUserId',p_linked_user_id)
  );
  return query select v_id,false;
end;
$$;

create or replace function public.powerhub_open_collector_session(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_opening_cash numeric,p_notes text,p_client_operation_id text
)
returns table(session_id bigint,replayed boolean)
language plpgsql
set search_path=public,pg_temp
as $$
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
  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
  ) values(
    p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'collector_session_open','collector_session',v_session_id,
    jsonb_build_object('sessionId',v_session_id,'openingCash',p_opening_cash::text,'notes',coalesce(p_notes,''))
  );
  return query select v_session_id,false;
end;
$$;

create or replace function public.powerhub_create_tariff_idempotent(
 p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_name text,p_code text,
 p_price_per_kwh numeric,p_fixed_fee numeric,p_tax_rate numeric,p_client_operation_id text
)
returns table(tariff_id bigint,replayed boolean)
language plpgsql
set search_path=public,pg_temp
as $$
declare v_id bigint; v_op public.offline_sync_operations%rowtype;
begin
  if nullif(btrim(p_client_operation_id),'') is null then raise exception 'CLIENT_OPERATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('tariff-create:'||p_user_id||':'||p_client_operation_id)::bigint);
  select * into v_op from public.offline_sync_operations
    where user_id=p_user_id and client_operation_id=p_client_operation_id for update;
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
    values(p_tenant_id,p_site_id,btrim(p_name),upper(btrim(p_code)),p_price_per_kwh,p_fixed_fee,p_tax_rate)
    returning id into v_id;
  insert into public.offline_sync_operations(
    tenant_id,site_id,user_id,client_operation_id,operation_type,entity_type,entity_id,response
  ) values(
    p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'tariff_create','tariff',v_id,
    jsonb_build_object('tariffId',v_id,'name',btrim(p_name),'code',upper(btrim(p_code)),
      'pricePerKwh',p_price_per_kwh,'fixedFee',p_fixed_fee,'taxRate',p_tax_rate)
  );
  return query select v_id,false;
exception when unique_violation then
  raise exception 'TARIFF_CODE_EXISTS';
end;
$$;

revoke execute on function public.powerhub_create_expense(bigint,bigint,bigint,bigint,text,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_expense(bigint,bigint,bigint,bigint,text,text,numeric,text,text) to service_role;
revoke execute on function public.powerhub_create_expense(bigint,bigint,bigint,bigint,text,text,numeric,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_expense(bigint,bigint,bigint,bigint,text,text,numeric,text) to service_role;

revoke execute on function public.powerhub_create_generator_online(bigint,bigint,bigint,text,text,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_generator_online(bigint,bigint,bigint,text,text,text,numeric,text,text) to service_role;
revoke execute on function public.powerhub_update_generator_online(bigint,bigint,bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.powerhub_update_generator_online(bigint,bigint,bigint,bigint,text,numeric,numeric,numeric,text,timestamptz,text) to service_role;

revoke execute on function public.powerhub_create_site_online(bigint,bigint,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_site_online(bigint,bigint,text,text,text,text,text) to service_role;
revoke execute on function public.powerhub_create_employee_online(bigint,bigint,bigint,text,text,text,text,text,text,numeric,date,text,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_employee_online(bigint,bigint,bigint,text,text,text,text,text,text,numeric,date,text,bigint,text) to service_role;

revoke execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text) from public,anon,authenticated;
revoke execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text) to service_role;
grant execute on function public.powerhub_open_collector_session(bigint,bigint,bigint,numeric,text,text) to service_role;

revoke execute on function public.powerhub_create_tariff_idempotent(bigint,bigint,bigint,text,text,numeric,numeric,numeric,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_tariff_idempotent(bigint,bigint,bigint,text,text,numeric,numeric,numeric,text) to service_role;
