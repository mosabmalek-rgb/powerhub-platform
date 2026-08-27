create or replace function public.powerhub_update_employee(
  p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_employee_id bigint, p_patch jsonb
)
returns table (employee_id bigint)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare v_before jsonb; v_after jsonb; v_role text;
begin
  if jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb or exists (
    select 1 from jsonb_object_keys(p_patch) as key
    where key not in ('fullName','identityNo','phone','jobTitle','employmentStatus','contractType','baseWage','hireDate','notes')
  ) then raise exception 'INVALID_EMPLOYEE_PATCH' using errcode='P0001'; end if;
  if (p_patch ? 'fullName' and (p_patch->>'fullName' is null or char_length(btrim(p_patch->>'fullName')) < 2))
    or (p_patch ? 'jobTitle' and (p_patch->>'jobTitle') not in ('accountant','collector','technician','worker','supervisor','other'))
    or (p_patch ? 'employmentStatus' and (p_patch->>'employmentStatus') not in ('active','suspended','ended'))
    or (p_patch ? 'contractType' and (p_patch->>'contractType') not in ('daily','monthly','collection_percentage'))
    or (p_patch ? 'baseWage' and ((p_patch->>'baseWage') !~ '^[0-9]+(\.[0-9]+)?$' or (p_patch->>'baseWage')::numeric > 100000000))
  then raise exception 'INVALID_EMPLOYEE_PATCH' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(p_tenant_id, hashtext('employee-update'));
  select to_jsonb(e) into v_before from public.employees e
    where e.id=p_employee_id and e.tenant_id=p_tenant_id and (e.site_id=p_site_id or e.site_id is null) for update;
  if v_before is null then raise exception 'EMPLOYEE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  update public.employees set
    full_name=case when p_patch ? 'fullName' then btrim(p_patch->>'fullName') else full_name end,
    identity_no=case when p_patch ? 'identityNo' then nullif(btrim(p_patch->>'identityNo'),'') else identity_no end,
    phone=case when p_patch ? 'phone' then nullif(btrim(p_patch->>'phone'),'') else phone end,
    job_title=case when p_patch ? 'jobTitle' then p_patch->>'jobTitle' else job_title end,
    employment_status=case when p_patch ? 'employmentStatus' then p_patch->>'employmentStatus' else employment_status end,
    contract_type=case when p_patch ? 'contractType' then p_patch->>'contractType' else contract_type end,
    base_wage=case when p_patch ? 'baseWage' then (p_patch->>'baseWage')::numeric else base_wage end,
    hire_date=case when p_patch ? 'hireDate' then nullif(p_patch->>'hireDate','')::date else hire_date end,
    notes=case when p_patch ? 'notes' then nullif(btrim(p_patch->>'notes'),'') else notes end,
    updated_at=now()
    where id=p_employee_id
    returning to_jsonb(employees) into v_after;
  select platform_role into v_role from public.users where id=p_user_id;
  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data)
    values(p_tenant_id,p_site_id,p_user_id,v_role,'employee',p_employee_id::text,'update',v_before,v_after);
  return query select p_employee_id;
end;
$$;
revoke execute on function public.powerhub_update_employee(bigint,bigint,bigint,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.powerhub_update_employee(bigint,bigint,bigint,bigint,jsonb) to service_role;
