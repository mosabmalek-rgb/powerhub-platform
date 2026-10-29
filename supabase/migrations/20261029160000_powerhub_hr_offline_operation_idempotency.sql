-- Idempotent server replay for offline HR commands. Browser clients can never call this RPC directly.
-- All employee, attendance and payroll effects happen in the same transaction as the operation result.
alter table public.employees
  add column if not exists hr_sync_version bigint not null default 1;
alter table public.employee_attendance
  add column if not exists hr_sync_version bigint not null default 1;

create or replace function public.powerhub_bump_hr_sync_version()
returns trigger
language plpgsql
set search_path=pg_catalog,public,pg_temp
as $$
begin
  new.hr_sync_version:=old.hr_sync_version+1;
  return new;
end $$;
alter function public.powerhub_bump_hr_sync_version() owner to postgres;
revoke all on function public.powerhub_bump_hr_sync_version() from public,anon,authenticated;
drop trigger if exists powerhub_hr_employees_version on public.employees;
create trigger powerhub_hr_employees_version
before update on public.employees for each row
execute function public.powerhub_bump_hr_sync_version();
drop trigger if exists powerhub_hr_attendance_version on public.employee_attendance;
create trigger powerhub_hr_attendance_version
before update on public.employee_attendance for each row
execute function public.powerhub_bump_hr_sync_version();

create table if not exists public.powerhub_hr_offline_operation_results (
  tenant_id bigint not null,
  operation_key uuid not null,
  site_id bigint not null,
  user_id bigint not null,
  operation_type text not null check (operation_type in ('employee_create','employee_update','attendance_upsert','payroll_draft')),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{32}$'),
  result_data jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id,operation_key),
  check (jsonb_typeof(result_data)='object')
);
create index if not exists powerhub_hr_offline_operation_recent_idx
  on public.powerhub_hr_offline_operation_results(tenant_id,site_id,created_at desc);
alter table public.powerhub_hr_offline_operation_results enable row level security;
revoke all on table public.powerhub_hr_offline_operation_results from public,anon,authenticated;
grant all on table public.powerhub_hr_offline_operation_results to service_role;

create or replace function public.powerhub_hr_replay_offline_operation(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_operation_key uuid,
  p_operation_type text,
  p_payload jsonb
)
returns table(entity_id bigint,total_net numeric,entity_updated_at timestamptz,entity_version bigint,replayed boolean)
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare
  v_existing public.powerhub_hr_offline_operation_results%rowtype;
  v_hash text;
  v_entity_id bigint;
  v_total_net numeric;
  v_updated_at timestamptz;
  v_version bigint;
  v_attendance_id bigint;
  v_attendance_mutation text;
  v_items jsonb;
  v_expected_version bigint;
  v_current_version bigint;
  v_existing_attendance_id bigint;
  v_payroll record;
  v_employee_patch jsonb;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
    or p_user_id is null or p_user_id<1 or p_operation_key is null
    or p_operation_type not in ('employee_create','employee_update','attendance_upsert','payroll_draft')
    or p_payload is null or jsonb_typeof(p_payload)<>'object'
  then raise exception 'INVALID_HR_OFFLINE_OPERATION' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id and s.status<>'archived') then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  v_hash:=md5(jsonb_build_object('tenantId',p_tenant_id,'siteId',p_site_id,'operationType',p_operation_type,'payload',p_payload)::text);
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':hr-offline:'||p_operation_key::text,0));

  select r.* into v_existing from public.powerhub_hr_offline_operation_results r
    where r.tenant_id=p_tenant_id and r.operation_key=p_operation_key for update;
  if found then
    if v_existing.site_id<>p_site_id or v_existing.user_id<>p_user_id
      or v_existing.operation_type<>p_operation_type or v_existing.payload_hash<>v_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='P0001';
    end if;
    return query select
      nullif(v_existing.result_data->>'entity_id','')::bigint,
      nullif(v_existing.result_data->>'total_net','')::numeric,
      nullif(v_existing.result_data->>'entity_updated_at','')::timestamptz,
      nullif(v_existing.result_data->>'entity_version','')::bigint,
      true;
    return;
  end if;

  if p_operation_type='employee_create' then
    select r.employee_id into v_entity_id from public.powerhub_create_employee(
      p_tenant_id,p_site_id,p_user_id,
      p_payload->>'fullName',
      nullif(p_payload->>'identityNo',''),
      nullif(p_payload->>'phone',''),
      p_payload->>'jobTitle',
      coalesce(nullif(p_payload->>'employmentStatus',''),'active'),
      p_payload->>'contractType',
      nullif(p_payload->>'baseWage','')::numeric,
      nullif(p_payload->>'hireDate','')::date,
      nullif(p_payload->>'notes',''),
      nullif(p_payload->>'linkedUserId','')::bigint
    ) r;
  elsif p_operation_type='employee_update' then
    if nullif(p_payload->>'employeeId','') is null
      or nullif(p_payload->>'expectedVersion','') is null
      or jsonb_typeof(p_payload->'patch')<>'object' or p_payload->'patch'='{}'::jsonb then
      raise exception 'INVALID_HR_OFFLINE_EMPLOYEE_UPDATE' using errcode='P0001';
    end if;
    v_entity_id:=(p_payload->>'employeeId')::bigint;
    v_expected_version:=(p_payload->>'expectedVersion')::bigint;
    select e.hr_sync_version into v_current_version from public.employees e
      where e.id=v_entity_id and e.tenant_id=p_tenant_id and (e.site_id=p_site_id or e.site_id is null) for update;
    if not found then raise exception 'EMPLOYEE_OUT_OF_SCOPE' using errcode='P0001'; end if;
    if v_current_version<>v_expected_version then raise exception 'EMPLOYEE_VERSION_CONFLICT' using errcode='P0001'; end if;
    v_employee_patch:=p_payload->'patch';
    perform * from public.powerhub_update_employee(p_tenant_id,p_site_id,p_user_id,v_entity_id,v_employee_patch);
  elsif p_operation_type='attendance_upsert' then
    if nullif(p_payload->>'employeeId','') is null or nullif(p_payload->>'workDate','') is null then
      raise exception 'INVALID_HR_OFFLINE_ATTENDANCE' using errcode='P0001';
    end if;
    v_entity_id:=(p_payload->>'employeeId')::bigint;
    v_expected_version:=nullif(p_payload->>'expectedVersion','')::bigint;
    select a.id,a.hr_sync_version into v_existing_attendance_id,v_current_version
      from public.employee_attendance a
      where a.tenant_id=p_tenant_id and a.site_id=p_site_id and a.employee_id=v_entity_id
        and a.work_date=(p_payload->>'workDate')::date
      for update;
    if found then
      if v_expected_version is null or v_current_version<>v_expected_version then
        raise exception 'ATTENDANCE_VERSION_CONFLICT' using errcode='P0001';
      end if;
    elsif v_expected_version is not null then
      raise exception 'ATTENDANCE_VERSION_CONFLICT' using errcode='P0001';
    end if;
    select a.attendance_id,a.mutation into v_attendance_id,v_attendance_mutation
    from public.powerhub_upsert_employee_attendance(
      p_tenant_id,p_site_id,p_user_id,v_entity_id,(p_payload->>'workDate')::date,
      coalesce(nullif(p_payload->>'regularHours','')::numeric,0),
      coalesce(nullif(p_payload->>'overtimeHours','')::numeric,0),
      coalesce(nullif(p_payload->>'absentDays','')::numeric,0),
      nullif(p_payload->>'notes','')
    ) a;
    v_entity_id:=v_attendance_id;
  elsif p_operation_type='payroll_draft' then
    if nullif(p_payload->>'period','') is null or jsonb_typeof(p_payload->'items')<>'array' then
      raise exception 'INVALID_PAYROLL_DRAFT_INPUT' using errcode='P0001';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'employee_id',nullif(item->>'employeeId','')::bigint,
      'extra_amount',coalesce(nullif(item->>'extraAmount','')::numeric,0),
      'advance_deduction',coalesce(nullif(item->>'advanceDeduction','')::numeric,0),
      'other_deduction',coalesce(nullif(item->>'otherDeduction','')::numeric,0),
      'notes',nullif(item->>'notes','')
    )),'[]'::jsonb) into v_items from jsonb_array_elements(p_payload->'items') as rows(item);
    select r.payroll_run_id,r.total_net into v_payroll
      from public.powerhub_create_payroll_draft(p_tenant_id,p_site_id,p_user_id,p_payload->>'period',v_items) r;
    v_entity_id:=v_payroll.payroll_run_id;
    v_total_net:=v_payroll.total_net;
  end if;

  if p_operation_type in ('employee_create','employee_update') then
    select e.updated_at,e.hr_sync_version into v_updated_at,v_version from public.employees e
      where e.tenant_id=p_tenant_id and e.id=v_entity_id;
  elsif p_operation_type='attendance_upsert' then
    select a.updated_at,a.hr_sync_version into v_updated_at,v_version from public.employee_attendance a
      where a.tenant_id=p_tenant_id and a.id=v_entity_id;
  end if;

  insert into public.powerhub_hr_offline_operation_results(
    tenant_id,operation_key,site_id,user_id,operation_type,payload_hash,result_data
  ) values (
    p_tenant_id,p_operation_key,p_site_id,p_user_id,p_operation_type,v_hash,
    jsonb_build_object('entity_id',v_entity_id,'total_net',v_total_net,
      'entity_updated_at',v_updated_at,'entity_version',v_version)
  );

  return query select v_entity_id,v_total_net,v_updated_at,v_version,false;
end $$;
alter function public.powerhub_hr_replay_offline_operation(bigint,bigint,bigint,uuid,text,jsonb) owner to postgres;
revoke all on function public.powerhub_hr_replay_offline_operation(bigint,bigint,bigint,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_hr_replay_offline_operation(bigint,bigint,bigint,uuid,text,jsonb) to service_role;


-- Re-project the exact optimistic version alongside the minimized employee and attendance rows.
create or replace function public.powerhub_project_hr_employee_delta_row(
  p_tenant_id bigint,p_site_id bigint,p_employee_id bigint
)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',e.id,'tenant_id',e.tenant_id,'site_id',e.site_id,
    'full_name',e.full_name,'job_title',e.job_title,'employment_status',e.employment_status,
    'contract_type',e.contract_type,'created_at',e.created_at,'version_no',e.hr_sync_version
  )
  from public.employees e
  where e.tenant_id=p_tenant_id and e.id=p_employee_id and (e.site_id=p_site_id or e.site_id is null)
$$;
alter function public.powerhub_project_hr_employee_delta_row(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_project_hr_employee_delta_row(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_project_hr_employee_delta_row(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_project_hr_attendance_delta_row(
  p_tenant_id bigint,p_site_id bigint,p_attendance_id bigint
)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',a.id,'tenant_id',a.tenant_id,'site_id',a.site_id,
    'attendance',jsonb_build_object(
      'id',a.id,'tenant_id',a.tenant_id,'employee_id',a.employee_id,'site_id',a.site_id,
      'work_date',a.work_date,'regular_hours',a.regular_hours,'overtime_hours',a.overtime_hours,
      'absent_days',a.absent_days,'notes',null,'created_by_user_id',null,
      'created_at',a.created_at,'updated_at',a.updated_at,'version_no',a.hr_sync_version
    ),
    'employee',jsonb_build_object(
      'id',e.id,'tenant_id',e.tenant_id,'site_id',e.site_id,
      'full_name',e.full_name,'job_title',e.job_title,'employment_status',e.employment_status
    )
  )
  from public.employee_attendance a
  join public.employees e on e.tenant_id=a.tenant_id and e.id=a.employee_id
    and (e.site_id=a.site_id or e.site_id is null)
  where a.tenant_id=p_tenant_id and a.site_id=p_site_id and a.id=p_attendance_id
$$;
alter function public.powerhub_project_hr_attendance_delta_row(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_project_hr_attendance_delta_row(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_project_hr_attendance_delta_row(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_capture_hr_employee_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_site_id bigint; v_changed boolean:=true;
begin
  if TG_OP='UPDATE' then
    v_changed:=OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id
      or OLD.full_name is distinct from NEW.full_name or OLD.job_title is distinct from NEW.job_title
      or OLD.employment_status is distinct from NEW.employment_status or OLD.contract_type is distinct from NEW.contract_type
      or OLD.created_at is distinct from NEW.created_at or OLD.hr_sync_version is distinct from NEW.hr_sync_version;
    if not v_changed then return NEW; end if;
  end if;
  if TG_OP='DELETE' or (TG_OP='UPDATE' and (OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id)) then
    for v_site_id in select s.id from public.sites s
      where s.tenant_id=OLD.tenant_id and (OLD.site_id is null or s.id=OLD.site_id) order by s.id
    loop
      perform public.powerhub_refresh_hr_employee_directory_delta_scope(OLD.tenant_id,v_site_id);
    end loop;
    perform public.powerhub_refresh_hr_attendance_for_employee(OLD.tenant_id,OLD.id);
  end if;
  if TG_OP<>'DELETE' then
    for v_site_id in select s.id from public.sites s
      where s.tenant_id=NEW.tenant_id and (NEW.site_id is null or s.id=NEW.site_id) order by s.id
    loop
      perform public.powerhub_refresh_hr_employee_directory_delta_scope(NEW.tenant_id,v_site_id);
    end loop;
    perform public.powerhub_refresh_hr_attendance_for_employee(NEW.tenant_id,NEW.id);
    return NEW;
  end if;
  return OLD;
end $$;
alter function public.powerhub_capture_hr_employee_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_hr_employee_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_hr_employee_delta_sync_change() to service_role;
