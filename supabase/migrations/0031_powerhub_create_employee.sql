create or replace function public.powerhub_create_employee(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_full_name text, p_identity_no text,
  p_phone text, p_job_title text, p_employment_status text, p_contract_type text, p_base_wage numeric,
  p_hire_date date, p_notes text, p_linked_user_id bigint
)
returns table (employee_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_employee_id bigint; v_role text;
begin
  if char_length(btrim(p_full_name)) < 2 or p_job_title not in ('accountant','collector','technician','worker','supervisor','other') or p_employment_status not in ('active','suspended','ended') or p_contract_type not in ('daily','monthly','collection_percentage') or p_base_wage < 0 or p_base_wage > 100000000 then
    raise exception 'INVALID_EMPLOYEE_INPUT' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(p_tenant_id, hashtext('employee-create'));
  perform 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id for share;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if p_linked_user_id is not null then
    perform 1 from public.tenant_members where tenant_id=p_tenant_id and user_id=p_linked_user_id and is_active=true for share;
    if not found then raise exception 'LINKED_USER_OUT_OF_SCOPE' using errcode='P0001'; end if;
  end if;
  insert into public.employees(tenant_id,site_id,linked_user_id,full_name,identity_no,phone,job_title,employment_status,contract_type,base_wage,hire_date,notes)
    values(p_tenant_id,p_site_id,p_linked_user_id,btrim(p_full_name),nullif(btrim(p_identity_no),''),nullif(btrim(p_phone),''),p_job_title,p_employment_status,p_contract_type,p_base_wage,p_hire_date,nullif(btrim(p_notes),''))
    returning id into v_employee_id;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_role,'employee',v_employee_id::text,'create',jsonb_build_object('fullName',p_full_name,'jobTitle',p_job_title,'employmentStatus',p_employment_status,'contractType',p_contract_type,'baseWage',p_base_wage,'linkedUserId',p_linked_user_id));
  return query select v_employee_id;
end;
$$;
revoke execute on function public.powerhub_create_employee(bigint,bigint,bigint,text,text,text,text,text,text,numeric,date,text,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_create_employee(bigint,bigint,bigint,text,text,text,text,text,text,numeric,date,text,bigint) to service_role;
