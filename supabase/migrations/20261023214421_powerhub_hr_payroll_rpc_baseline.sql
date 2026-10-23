-- Restore the HR RPC baseline where core tables are present but the HR procedures were not applied.
-- Definitions are aligned with the currently deployed production RPCs; this is additive and repeat-safe.

CREATE OR REPLACE FUNCTION public.powerhub_create_employee(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_full_name text, p_identity_no text, p_phone text, p_job_title text, p_employment_status text, p_contract_type text, p_base_wage numeric, p_hire_date date, p_notes text, p_linked_user_id bigint)
 RETURNS TABLE(employee_id bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$ declare v_employee_id bigint; v_role text; begin if char_length(btrim(p_full_name)) < 2 or p_job_title not in ('accountant','collector','technician','worker','supervisor','other') or p_employment_status not in ('active','suspended','ended') or p_contract_type not in ('daily','monthly','collection_percentage') or p_base_wage < 0 or p_base_wage > 100000000 then raise exception 'INVALID_EMPLOYEE_INPUT' using errcode='P0001'; end if; perform pg_advisory_xact_lock(hashtext('employee-create:' || p_tenant_id::text)::bigint); perform 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id for share; if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if; if p_linked_user_id is not null then perform 1 from public.tenant_members where tenant_id=p_tenant_id and user_id=p_linked_user_id and is_active=true for share; if not found then raise exception 'LINKED_USER_OUT_OF_SCOPE' using errcode='P0001'; end if; end if; insert into public.employees(tenant_id,site_id,linked_user_id,full_name,identity_no,phone,job_title,employment_status,contract_type,base_wage,hire_date,notes) values(p_tenant_id,p_site_id,p_linked_user_id,btrim(p_full_name),nullif(btrim(p_identity_no),''),nullif(btrim(p_phone),''),p_job_title,p_employment_status,p_contract_type,p_base_wage,p_hire_date,nullif(btrim(p_notes),'')) returning id into v_employee_id; select platform_role into v_role from public.users where id=p_user_id; insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'employee',v_employee_id::text,'create',jsonb_build_object('fullName',p_full_name,'jobTitle',p_job_title,'employmentStatus',p_employment_status,'contractType',p_contract_type,'baseWage',p_base_wage,'linkedUserId',p_linked_user_id)); return query select v_employee_id; end; $function$;

REVOKE EXECUTE ON FUNCTION public.powerhub_create_employee(bigint,bigint,bigint,text,text,text,text,text,text,numeric,date,text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_create_employee(bigint,bigint,bigint,text,text,text,text,text,text,numeric,date,text,bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_update_employee(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_employee_id bigint, p_patch jsonb)
 RETURNS TABLE(employee_id bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$ declare v_before jsonb; v_after jsonb; v_role text; begin if jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb or exists (select 1 from jsonb_object_keys(p_patch) as key where key not in ('fullName','identityNo','phone','jobTitle','employmentStatus','contractType','baseWage','hireDate','notes')) then raise exception 'INVALID_EMPLOYEE_PATCH' using errcode='P0001'; end if; if (p_patch ? 'fullName' and (p_patch->>'fullName' is null or char_length(btrim(p_patch->>'fullName')) < 2)) or (p_patch ? 'jobTitle' and (p_patch->>'jobTitle') not in ('accountant','collector','technician','worker','supervisor','other')) or (p_patch ? 'employmentStatus' and (p_patch->>'employmentStatus') not in ('active','suspended','ended')) or (p_patch ? 'contractType' and (p_patch->>'contractType') not in ('daily','monthly','collection_percentage')) or (p_patch ? 'baseWage' and ((p_patch->>'baseWage') !~ '^[0-9]+(\.[0-9]+)?$' or (p_patch->>'baseWage')::numeric > 100000000)) then raise exception 'INVALID_EMPLOYEE_PATCH' using errcode='P0001'; end if; perform pg_advisory_xact_lock(hashtext('employee-update:' || p_tenant_id::text)::bigint); select to_jsonb(e) into v_before from public.employees e where e.id=p_employee_id and e.tenant_id=p_tenant_id and (e.site_id=p_site_id or e.site_id is null) for update; if v_before is null then raise exception 'EMPLOYEE_OUT_OF_SCOPE' using errcode='P0001'; end if; update public.employees set full_name=case when p_patch ? 'fullName' then btrim(p_patch->>'fullName') else full_name end, identity_no=case when p_patch ? 'identityNo' then nullif(btrim(p_patch->>'identityNo'),'') else identity_no end, phone=case when p_patch ? 'phone' then nullif(btrim(p_patch->>'phone'),'') else phone end, job_title=case when p_patch ? 'jobTitle' then p_patch->>'jobTitle' else job_title end, employment_status=case when p_patch ? 'employmentStatus' then p_patch->>'employmentStatus' else employment_status end, contract_type=case when p_patch ? 'contractType' then p_patch->>'contractType' else contract_type end, base_wage=case when p_patch ? 'baseWage' then (p_patch->>'baseWage')::numeric else base_wage end, hire_date=case when p_patch ? 'hireDate' then nullif(p_patch->>'hireDate','')::date else hire_date end, notes=case when p_patch ? 'notes' then nullif(btrim(p_patch->>'notes'),'') else notes end, updated_at=now() where id=p_employee_id returning to_jsonb(employees) into v_after; select platform_role into v_role from public.users where id=p_user_id; insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data) values(p_tenant_id,p_site_id,p_user_id,v_role,'employee',p_employee_id::text,'update',v_before,v_after); return query select p_employee_id; end; $function$;

REVOKE EXECUTE ON FUNCTION public.powerhub_update_employee(bigint,bigint,bigint,bigint,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_update_employee(bigint,bigint,bigint,bigint,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.powerhub_upsert_employee_attendance(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_employee_id bigint, p_work_date date, p_regular_hours numeric, p_overtime_hours numeric, p_absent_days numeric, p_notes text)
 RETURNS TABLE(attendance_id bigint, mutation text)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_before jsonb; v_role text; v_attendance_id bigint; v_mutation text;
begin
  if p_work_date is null or p_regular_hours < 0 or p_regular_hours > 24 or p_overtime_hours < 0 or p_overtime_hours > 24 or p_absent_days < 0 or p_absent_days > 1 then raise exception 'INVALID_ATTENDANCE_INPUT' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('attendance:' || p_tenant_id::text || ':' || p_employee_id::text || ':' || p_work_date::text)::bigint);
  perform 1 from public.employees where id = p_employee_id and tenant_id = p_tenant_id and (site_id = p_site_id or site_id is null) for update;
  if not found then raise exception 'EMPLOYEE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select to_jsonb(a), a.id into v_before, v_attendance_id from public.employee_attendance a where a.tenant_id = p_tenant_id and a.employee_id = p_employee_id and a.work_date = p_work_date for update;
  if v_attendance_id is null then
    insert into public.employee_attendance(tenant_id, employee_id, site_id, work_date, regular_hours, overtime_hours, absent_days, notes, created_by_user_id) values(p_tenant_id, p_employee_id, p_site_id, p_work_date, p_regular_hours, p_overtime_hours, p_absent_days, nullif(btrim(p_notes), ''), p_user_id) returning id into v_attendance_id;
    v_mutation := 'create';
  else
    update public.employee_attendance set site_id = p_site_id, regular_hours = p_regular_hours, overtime_hours = p_overtime_hours, absent_days = p_absent_days, notes = nullif(btrim(p_notes), ''), updated_at = now() where id = v_attendance_id;
    v_mutation := 'update';
  end if;
  select platform_role into v_role from public.users where id = p_user_id;
  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data, after_data) values(p_tenant_id, p_site_id, p_user_id, v_role, 'employee_attendance', v_attendance_id::text, v_mutation, v_before, jsonb_build_object('employeeId', p_employee_id, 'workDate', p_work_date, 'regularHours', p_regular_hours, 'overtimeHours', p_overtime_hours, 'absentDays', p_absent_days, 'notes', p_notes));
  return query select v_attendance_id, v_mutation;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.powerhub_upsert_employee_attendance(bigint,bigint,bigint,bigint,date,numeric,numeric,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_upsert_employee_attendance(bigint,bigint,bigint,bigint,date,numeric,numeric,numeric,text) TO service_role;

NOTIFY pgrst, 'reload schema';
