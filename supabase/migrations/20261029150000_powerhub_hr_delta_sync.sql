-- Private minimized HR Delta feeds. Raw identity/contact/wage/notes/payroll data is never projected.
alter table public.powerhub_sync_scope_state drop constraint if exists powerhub_sync_scope_state_entity_type_check;
alter table public.powerhub_sync_scope_state add constraint powerhub_sync_scope_state_entity_type_check
  check (entity_type in (
    'sites','subscribers','generators','readings','tariffs','invoices','payments','expenses',
    'company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers',
    'inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers',
    'inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings',
    'maintenance_preventive_plans','fuel_events','maintenance_work_orders','hr_employee_directory','hr_attendance'
  ) or entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$');
alter table public.powerhub_sync_changes drop constraint if exists powerhub_sync_changes_entity_type_check;
alter table public.powerhub_sync_changes add constraint powerhub_sync_changes_entity_type_check
  check (entity_type in (
    'sites','subscribers','generators','readings','tariffs','invoices','payments','expenses',
    'company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers',
    'inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers',
    'inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings',
    'maintenance_preventive_plans','fuel_events','maintenance_work_orders','hr_employee_directory','hr_attendance'
  ) or entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$');

create table if not exists public.powerhub_hr_delta_scope_membership (
  tenant_id bigint not null,
  site_id bigint not null references public.sites(id) on delete cascade,
  entity_type text not null check (entity_type in ('hr_employee_directory','hr_attendance')),
  entity_id text not null,
  row_data jsonb not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id,site_id,entity_type,entity_id),
  check (length(entity_id) between 1 and 100)
);
create index if not exists powerhub_hr_delta_membership_recent_idx
  on public.powerhub_hr_delta_scope_membership(tenant_id,site_id,entity_type,updated_at desc);
alter table public.powerhub_hr_delta_scope_membership enable row level security;
revoke all on table public.powerhub_hr_delta_scope_membership from public,anon,authenticated;
grant all on table public.powerhub_hr_delta_scope_membership to service_role;

create or replace function public.powerhub_project_hr_employee_delta_row(
  p_tenant_id bigint,p_site_id bigint,p_employee_id bigint
)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',e.id,'tenant_id',e.tenant_id,'site_id',e.site_id,
    'full_name',e.full_name,'job_title',e.job_title,
    'employment_status',e.employment_status,'contract_type',e.contract_type,
    'created_at',e.created_at
  )
  from public.employees e
  where e.tenant_id=p_tenant_id and e.id=p_employee_id
    and (e.site_id=p_site_id or e.site_id is null)
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
      'created_at',a.created_at,'updated_at',a.updated_at
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

create or replace function public.powerhub_append_hr_delta_sync_change(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_entity_id text,p_change_type text,p_row_data jsonb
)
returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_cursor bigint; v_cutoff bigint; v_row_site bigint;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
    or p_entity_type not in ('hr_employee_directory','hr_attendance')
    or p_entity_id is null or length(p_entity_id) not between 1 and 100
    or p_change_type not in ('upsert','delete')
    or (p_change_type='upsert' and (p_row_data is null or p_row_data->>'id' is distinct from p_entity_id
      or nullif(p_row_data->>'tenant_id','')::bigint is distinct from p_tenant_id))
    or (p_change_type='delete' and p_row_data is not null)
    or not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id)
  then raise exception 'POWERHUB_HR_DELTA_CHANGE_INVALID' using errcode='P0001'; end if;
  if p_change_type='upsert' then
    v_row_site:=nullif(p_row_data->>'site_id','')::bigint;
    if (p_entity_type='hr_attendance' and v_row_site is distinct from p_site_id)
      or (p_entity_type='hr_employee_directory' and v_row_site is not null and v_row_site<>p_site_id)
    then raise exception 'POWERHUB_HR_DELTA_ROW_OUT_OF_SCOPE' using errcode='P0001'; end if;
  end if;
  insert into public.powerhub_sync_scope_state(tenant_id,site_id,entity_type,last_cursor,retained_from_cursor,updated_at)
  values(p_tenant_id,p_site_id,p_entity_type,1,0,clock_timestamp())
  on conflict(tenant_id,site_id,entity_type) do update
    set last_cursor=public.powerhub_sync_scope_state.last_cursor+1,updated_at=clock_timestamp()
  returning last_cursor into v_cursor;
  insert into public.powerhub_sync_changes(tenant_id,site_id,entity_type,cursor,entity_id,change_type,row_data,changed_at)
  values(p_tenant_id,p_site_id,p_entity_type,v_cursor,p_entity_id,p_change_type,p_row_data,clock_timestamp());
  if v_cursor>10000 and mod(v_cursor,500)=0 then
    v_cutoff:=v_cursor-10000;
    delete from public.powerhub_sync_changes c
      where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type and c.cursor<=v_cutoff;
    update public.powerhub_sync_scope_state s
      set retained_from_cursor=greatest(s.retained_from_cursor,v_cutoff),updated_at=clock_timestamp()
      where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
  end if;
  return v_cursor;
end $$;
alter function public.powerhub_append_hr_delta_sync_change(bigint,bigint,text,text,text,jsonb) owner to postgres;
revoke all on function public.powerhub_append_hr_delta_sync_change(bigint,bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_append_hr_delta_sync_change(bigint,bigint,text,text,text,jsonb) to service_role;

create or replace function public.powerhub_emit_hr_delta_sync_change(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_entity_id bigint,p_row_data jsonb
)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
begin
  if p_row_data is null then
    perform public.powerhub_append_hr_delta_sync_change(p_tenant_id,p_site_id,p_entity_type,p_entity_id::text,'delete',null);
  else
    perform public.powerhub_append_hr_delta_sync_change(p_tenant_id,p_site_id,p_entity_type,p_entity_id::text,'upsert',p_row_data);
  end if;
end $$;
alter function public.powerhub_emit_hr_delta_sync_change(bigint,bigint,text,bigint,jsonb) owner to postgres;
revoke all on function public.powerhub_emit_hr_delta_sync_change(bigint,bigint,text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_emit_hr_delta_sync_change(bigint,bigint,text,bigint,jsonb) to service_role;

create or replace function public.powerhub_refresh_hr_employee_directory_delta_scope(p_tenant_id bigint,p_site_id bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_employee record; v_old record; v_lock_key bigint;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then return; end if;
  v_lock_key:=hashtextextended(p_tenant_id::text||':'||p_site_id::text||':hr_employee_directory',0);
  perform pg_advisory_xact_lock(v_lock_key);
  for v_old in
    select m.entity_id from public.powerhub_hr_delta_scope_membership m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_employee_directory'
      and not exists (
        select 1 from (
          select e.id from public.employees e where e.tenant_id=p_tenant_id and (e.site_id=p_site_id or e.site_id is null)
          order by e.created_at desc,e.id desc limit 500
        ) current_rows where current_rows.id::text=m.entity_id
      )
  loop
    perform public.powerhub_emit_hr_delta_sync_change(p_tenant_id,p_site_id,'hr_employee_directory',v_old.entity_id::bigint,null);
    delete from public.powerhub_hr_delta_scope_membership m
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_employee_directory' and m.entity_id=v_old.entity_id;
  end loop;
  for v_employee in
    select e.id,public.powerhub_project_hr_employee_delta_row(p_tenant_id,p_site_id,e.id) as projected
    from public.employees e where e.tenant_id=p_tenant_id and (e.site_id=p_site_id or e.site_id is null)
    order by e.created_at desc,e.id desc limit 500
  loop
    select m.row_data into v_old from public.powerhub_hr_delta_scope_membership m
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_employee_directory' and m.entity_id=v_employee.id::text;
    if not found then
      perform public.powerhub_emit_hr_delta_sync_change(p_tenant_id,p_site_id,'hr_employee_directory',v_employee.id,v_employee.projected);
      insert into public.powerhub_hr_delta_scope_membership(tenant_id,site_id,entity_type,entity_id,row_data)
      values(p_tenant_id,p_site_id,'hr_employee_directory',v_employee.id::text,v_employee.projected);
    elsif v_old is distinct from v_employee.projected then
      perform public.powerhub_emit_hr_delta_sync_change(p_tenant_id,p_site_id,'hr_employee_directory',v_employee.id,v_employee.projected);
      update public.powerhub_hr_delta_scope_membership m set row_data=v_employee.projected,updated_at=clock_timestamp()
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_employee_directory' and m.entity_id=v_employee.id::text;
    end if;
  end loop;
end $$;
alter function public.powerhub_refresh_hr_employee_directory_delta_scope(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_hr_employee_directory_delta_scope(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_hr_employee_directory_delta_scope(bigint,bigint) to service_role;

create or replace function public.powerhub_refresh_hr_attendance_delta_scope(p_tenant_id bigint,p_site_id bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_attendance record; v_old record; v_lock_key bigint;
begin
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then return; end if;
  v_lock_key:=hashtextextended(p_tenant_id::text||':'||p_site_id::text||':hr_attendance',0);
  perform pg_advisory_xact_lock(v_lock_key);
  for v_old in
    select m.entity_id from public.powerhub_hr_delta_scope_membership m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_attendance'
      and not exists (
        select 1 from (
          select a.id from public.employee_attendance a
          join public.employees e on e.tenant_id=a.tenant_id and e.id=a.employee_id and (e.site_id=a.site_id or e.site_id is null)
          where a.tenant_id=p_tenant_id and a.site_id=p_site_id
          order by a.work_date desc,a.id desc limit 1000
        ) current_rows where current_rows.id::text=m.entity_id
      )
  loop
    perform public.powerhub_emit_hr_delta_sync_change(p_tenant_id,p_site_id,'hr_attendance',v_old.entity_id::bigint,null);
    delete from public.powerhub_hr_delta_scope_membership m
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_attendance' and m.entity_id=v_old.entity_id;
  end loop;
  for v_attendance in
    select a.id,public.powerhub_project_hr_attendance_delta_row(p_tenant_id,p_site_id,a.id) as projected
    from public.employee_attendance a
    join public.employees e on e.tenant_id=a.tenant_id and e.id=a.employee_id and (e.site_id=a.site_id or e.site_id is null)
    where a.tenant_id=p_tenant_id and a.site_id=p_site_id
    order by a.work_date desc,a.id desc limit 1000
  loop
    select m.row_data into v_old from public.powerhub_hr_delta_scope_membership m
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_attendance' and m.entity_id=v_attendance.id::text;
    if not found then
      perform public.powerhub_emit_hr_delta_sync_change(p_tenant_id,p_site_id,'hr_attendance',v_attendance.id,v_attendance.projected);
      insert into public.powerhub_hr_delta_scope_membership(tenant_id,site_id,entity_type,entity_id,row_data)
      values(p_tenant_id,p_site_id,'hr_attendance',v_attendance.id::text,v_attendance.projected);
    elsif v_old is distinct from v_attendance.projected then
      perform public.powerhub_emit_hr_delta_sync_change(p_tenant_id,p_site_id,'hr_attendance',v_attendance.id,v_attendance.projected);
      update public.powerhub_hr_delta_scope_membership m set row_data=v_attendance.projected,updated_at=clock_timestamp()
      where m.tenant_id=p_tenant_id and m.site_id=p_site_id and m.entity_type='hr_attendance' and m.entity_id=v_attendance.id::text;
    end if;
  end loop;
end $$;
alter function public.powerhub_refresh_hr_attendance_delta_scope(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_hr_attendance_delta_scope(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_hr_attendance_delta_scope(bigint,bigint) to service_role;

create or replace function public.powerhub_refresh_hr_attendance_for_employee(p_tenant_id bigint,p_employee_id bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_site_id bigint;
begin
  for v_site_id in
    select distinct a.site_id from public.employee_attendance a
    join public.sites s on s.id=a.site_id and s.tenant_id=a.tenant_id
    where a.tenant_id=p_tenant_id and a.employee_id=p_employee_id order by a.site_id
  loop
    perform public.powerhub_refresh_hr_attendance_delta_scope(p_tenant_id,v_site_id);
  end loop;
end $$;
alter function public.powerhub_refresh_hr_attendance_for_employee(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_hr_attendance_for_employee(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_hr_attendance_for_employee(bigint,bigint) to service_role;

create or replace function public.powerhub_capture_hr_employee_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_site_id bigint; v_changed boolean:=true;
begin
  if TG_OP='UPDATE' then
    v_changed:=OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id
      or OLD.full_name is distinct from NEW.full_name or OLD.job_title is distinct from NEW.job_title
      or OLD.employment_status is distinct from NEW.employment_status or OLD.contract_type is distinct from NEW.contract_type
      or OLD.created_at is distinct from NEW.created_at;
    if not v_changed then return NEW; end if;
  end if;
  if TG_OP='DELETE' or (TG_OP='UPDATE' and (OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id)) then
    for v_site_id in
      select s.id from public.sites s where s.tenant_id=OLD.tenant_id and (OLD.site_id is null or s.id=OLD.site_id) order by s.id
    loop
      perform public.powerhub_refresh_hr_employee_directory_delta_scope(OLD.tenant_id,v_site_id);
    end loop;
    perform public.powerhub_refresh_hr_attendance_for_employee(OLD.tenant_id,OLD.id);
  end if;
  if TG_OP<>'DELETE' then
    for v_site_id in
      select s.id from public.sites s where s.tenant_id=NEW.tenant_id and (NEW.site_id is null or s.id=NEW.site_id) order by s.id
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

create or replace function public.powerhub_capture_hr_attendance_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
begin
  if TG_OP='DELETE' then
    perform public.powerhub_refresh_hr_attendance_delta_scope(OLD.tenant_id,OLD.site_id);
    return OLD;
  end if;
  if TG_OP='UPDATE' and (OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id) then
    perform public.powerhub_refresh_hr_attendance_delta_scope(OLD.tenant_id,OLD.site_id);
  end if;
  perform public.powerhub_refresh_hr_attendance_delta_scope(NEW.tenant_id,NEW.site_id);
  return NEW;
end $$;
alter function public.powerhub_capture_hr_attendance_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_hr_attendance_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_hr_attendance_delta_sync_change() to service_role;

drop trigger if exists powerhub_delta_hr_employees on public.employees;
create trigger powerhub_delta_hr_employees after insert or update or delete on public.employees
for each row execute function public.powerhub_capture_hr_employee_delta_sync_change();
drop trigger if exists powerhub_delta_hr_attendance on public.employee_attendance;
create trigger powerhub_delta_hr_attendance after insert or update or delete on public.employee_attendance
for each row execute function public.powerhub_capture_hr_attendance_delta_sync_change();

create index if not exists employees_tenant_site_created_delta_idx on public.employees(tenant_id,site_id,created_at desc,id desc);
create index if not exists employee_attendance_tenant_site_date_delta_idx on public.employee_attendance(tenant_id,site_id,work_date desc,id desc);

create or replace function public.powerhub_get_hr_sync_snapshot(p_tenant_id bigint,p_site_id bigint,p_entity_type text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_cursor bigint:=0; v_retained bigint:=0; v_rows jsonb:='[]'::jsonb;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001'; end if;
  if p_entity_type not in ('hr_employee_directory','hr_attendance') then raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if p_entity_type='hr_employee_directory' then
    perform public.powerhub_refresh_hr_employee_directory_delta_scope(p_tenant_id,p_site_id);
    select coalesce(jsonb_agg(public.powerhub_project_hr_employee_delta_row(p_tenant_id,p_site_id,r.id) order by r.created_at desc,r.id desc),'[]'::jsonb) into v_rows
    from (select e.id,e.created_at from public.employees e where e.tenant_id=p_tenant_id and (e.site_id=p_site_id or e.site_id is null) order by e.created_at desc,e.id desc limit 500) r;
  else
    perform public.powerhub_refresh_hr_attendance_delta_scope(p_tenant_id,p_site_id);
    select coalesce(jsonb_agg(public.powerhub_project_hr_attendance_delta_row(p_tenant_id,p_site_id,r.id) order by r.work_date desc,r.id desc),'[]'::jsonb) into v_rows
    from (
      select a.id,a.work_date from public.employee_attendance a join public.employees e on e.tenant_id=a.tenant_id and e.id=a.employee_id and (e.site_id=a.site_id or e.site_id is null)
      where a.tenant_id=p_tenant_id and a.site_id=p_site_id order by a.work_date desc,a.id desc limit 1000
    ) r;
  end if;
  select s.last_cursor,s.retained_from_cursor into v_cursor,v_retained from public.powerhub_sync_scope_state s where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
  if not found then v_cursor:=0; v_retained:=0; end if;
  return jsonb_build_object('status','ok','entity_type',p_entity_type,'snapshot_cursor',v_cursor::text,'retained_from_cursor',v_retained::text,'rows',v_rows);
end $$;
alter function public.powerhub_get_hr_sync_snapshot(bigint,bigint,text) owner to postgres;
revoke all on function public.powerhub_get_hr_sync_snapshot(bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_get_hr_sync_snapshot(bigint,bigint,text) to service_role;

create or replace function public.powerhub_pull_hr_sync_delta(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_after_cursor bigint,p_through_cursor bigint default null,p_page_size integer default 200
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$
declare v_current bigint:=0; v_retained bigint:=0; v_target bigint:=0; v_next bigint:=0; v_last bigint; v_more boolean:=false; v_changes jsonb:='[]'::jsonb;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001'; end if;
  if p_entity_type not in ('hr_employee_directory','hr_attendance') then raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001'; end if;
  if p_page_size is null or p_page_size<1 or p_page_size>500 then raise exception 'POWERHUB_SYNC_PAGE_SIZE_INVALID' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  select s.last_cursor,s.retained_from_cursor into v_current,v_retained from public.powerhub_sync_scope_state s where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
  if not found then v_current:=0; v_retained:=0; end if;
  if p_after_cursor is null or p_after_cursor<v_retained then
    return jsonb_build_object('status','reset_required','entity_type',p_entity_type,'current_cursor',v_current::text,'retained_from_cursor',v_retained::text,'snapshot_cursor',v_current::text,'through_cursor',v_current::text,'next_cursor',null,'has_more',false,'changes','[]'::jsonb);
  end if;
  if p_after_cursor<0 or p_after_cursor>v_current then raise exception 'POWERHUB_SYNC_CURSOR_INVALID' using errcode='P0001'; end if;
  if p_through_cursor is null then v_target:=v_current;
  else
    v_target:=p_through_cursor;
    if v_target<p_after_cursor or v_target>v_current then raise exception 'POWERHUB_SYNC_TARGET_CURSOR_INVALID' using errcode='P0001'; end if;
  end if;
  with page_rows as (
    select c.cursor,c.entity_type,c.entity_id,c.change_type,c.row_data,c.changed_at
    from public.powerhub_sync_changes c where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type
      and c.cursor>p_after_cursor and c.cursor<=v_target order by c.cursor limit p_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object('cursor',p.cursor::text,'entity_type',p.entity_type,'entity_id',p.entity_id,'operation',p.change_type,'row_data',p.row_data,'changed_at',p.changed_at) order by p.cursor),'[]'::jsonb),max(p.cursor)
  into v_changes,v_last from page_rows p;
  select exists(select 1 from public.powerhub_sync_changes c where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type and c.cursor>coalesce(v_last,p_after_cursor) and c.cursor<=v_target) into v_more;
  if v_more then v_next:=coalesce(v_last,p_after_cursor); else v_next:=v_target; end if;
  return jsonb_build_object('status','ok','entity_type',p_entity_type,'current_cursor',v_current::text,'retained_from_cursor',v_retained::text,'snapshot_cursor',null,'through_cursor',v_target::text,'next_cursor',v_next::text,'has_more',v_more,'changes',v_changes);
end $$;
alter function public.powerhub_pull_hr_sync_delta(bigint,bigint,text,bigint,bigint,integer) owner to postgres;
revoke all on function public.powerhub_pull_hr_sync_delta(bigint,bigint,text,bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_pull_hr_sync_delta(bigint,bigint,text,bigint,bigint,integer) to service_role;
