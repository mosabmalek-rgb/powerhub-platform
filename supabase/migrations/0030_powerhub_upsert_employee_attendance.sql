create or replace function public.powerhub_upsert_employee_attendance(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_employee_id bigint,
  p_work_date date,
  p_regular_hours numeric,
  p_overtime_hours numeric,
  p_absent_days numeric,
  p_notes text
)
returns table (attendance_id bigint, mutation text)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_before jsonb;
  v_role text;
  v_attendance_id bigint;
  v_mutation text;
begin
  if p_work_date is null or p_regular_hours < 0 or p_regular_hours > 24 or p_overtime_hours < 0 or p_overtime_hours > 24 or p_absent_days < 0 or p_absent_days > 1 then
    raise exception 'INVALID_ATTENDANCE_INPUT' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id, hashtext('attendance:' || p_employee_id::text || ':' || p_work_date::text));
  perform 1 from public.employees
    where id = p_employee_id and tenant_id = p_tenant_id and (site_id = p_site_id or site_id is null)
    for update;
  if not found then raise exception 'EMPLOYEE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select to_jsonb(a), a.id into v_before, v_attendance_id
    from public.employee_attendance a
    where a.tenant_id = p_tenant_id and a.employee_id = p_employee_id and a.work_date = p_work_date
    for update;

  if v_attendance_id is null then
    insert into public.employee_attendance(tenant_id, employee_id, site_id, work_date, regular_hours, overtime_hours, absent_days, notes, created_by_user_id)
      values(p_tenant_id, p_employee_id, p_site_id, p_work_date, p_regular_hours, p_overtime_hours, p_absent_days, nullif(btrim(p_notes), ''), p_user_id)
      returning id into v_attendance_id;
    v_mutation := 'create';
  else
    update public.employee_attendance
      set site_id = p_site_id, regular_hours = p_regular_hours, overtime_hours = p_overtime_hours,
          absent_days = p_absent_days, notes = nullif(btrim(p_notes), ''), updated_at = now()
      where id = v_attendance_id;
    v_mutation := 'update';
  end if;

  select platform_role into v_role from public.users where id = p_user_id;
  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data, after_data)
    values(p_tenant_id, p_site_id, p_user_id, v_role, 'employee_attendance', v_attendance_id::text, v_mutation, v_before,
      jsonb_build_object('employeeId', p_employee_id, 'workDate', p_work_date, 'regularHours', p_regular_hours, 'overtimeHours', p_overtime_hours, 'absentDays', p_absent_days, 'notes', p_notes));

  return query select v_attendance_id, v_mutation;
end;
$$;

revoke execute on function public.powerhub_upsert_employee_attendance(bigint,bigint,bigint,bigint,date,numeric,numeric,numeric,text) from public, anon, authenticated;
grant execute on function public.powerhub_upsert_employee_attendance(bigint,bigint,bigint,bigint,date,numeric,numeric,numeric,text) to service_role;
