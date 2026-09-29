alter table public.offline_sync_operations
  drop constraint if exists offline_sync_operations_operation_type_check;

alter table public.offline_sync_operations
  add constraint offline_sync_operations_operation_type_check
  check (operation_type = any (array[
    'subscriber_create','subscriber_update','generator_create','generator_update',
    'invoice_issue','payment_create','account_movement_create','account_transfer_create',
    'expense_create','employee_create','site_create'
  ]::text[]));

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
  ) values (
    p_tenant_id,p_site_id,p_user_id,p_client_operation_id,'employee_create','employee',v_id,
    jsonb_build_object(
      'employeeId',v_id,'fullName',btrim(p_full_name),
      'identityNo',nullif(btrim(p_identity_no),''),'phone',nullif(btrim(p_phone),''),
      'jobTitle',p_job_title,'employmentStatus',p_employment_status,'contractType',p_contract_type,
      'baseWage',p_base_wage,'hireDate',p_hire_date,'notes',nullif(btrim(p_notes),''),
      'linkedUserId',p_linked_user_id
    )
  );
  return query select v_id,false;
end;
$$;

revoke execute on function public.powerhub_create_employee_online(bigint,bigint,bigint,text,text,text,text,text,text,numeric,date,text,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_employee_online(bigint,bigint,bigint,text,text,text,text,text,text,numeric,date,text,bigint,text) to service_role;
