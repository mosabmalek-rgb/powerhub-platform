-- Operational Delta feeds for safe fuel readings and preventive maintenance plans.
-- Text notes/correction reasons and actor identifiers are deliberately not projected.
-- Financial fuel costs and maintenance work-order costing remain outside these feeds.

alter table public.powerhub_sync_scope_state drop constraint if exists powerhub_sync_scope_state_entity_type_check;
alter table public.powerhub_sync_scope_state add constraint powerhub_sync_scope_state_entity_type_check
  check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices','payments','expenses','company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers','inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings','maintenance_preventive_plans'));
alter table public.powerhub_sync_changes drop constraint if exists powerhub_sync_changes_entity_type_check;
alter table public.powerhub_sync_changes add constraint powerhub_sync_changes_entity_type_check
  check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices','payments','expenses','company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers','inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings','maintenance_preventive_plans'));

create or replace function public.powerhub_project_fuel_reading_delta_row(
  p_tenant_id bigint, p_site_id bigint, p_reading_id bigint
)
returns jsonb
language sql
stable
security definer
set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',r.id,
    'reading_id',r.id,
    'tenant_id',r.tenant_id,
    'site_id',r.site_id,
    'generator_id',r.generator_id,
    'generator_name',g.name,
    'reading_type',r.reading_type,
    'tank_warehouse_id',r.tank_warehouse_id,
    'tank_name',w.name,
    'reading_value',r.reading_value,
    'recorded_at',r.recorded_at,
    'reference_no',null,
    'notes',null,
    'corrects_reading_id',r.corrects_reading_id,
    'correction_reason',null,
    'created_by_user_id',null,
    'created_at',r.created_at
  )
  from public.generator_fuel_readings r
  join public.generators g
    on g.tenant_id=r.tenant_id and g.site_id=r.site_id and g.id=r.generator_id
  left join public.inventory_warehouses w
    on w.tenant_id=r.tenant_id and w.site_id=r.site_id and w.id=r.tank_warehouse_id
  where r.tenant_id=p_tenant_id and r.site_id=p_site_id and r.id=p_reading_id
$$;
alter function public.powerhub_project_fuel_reading_delta_row(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_project_fuel_reading_delta_row(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_project_fuel_reading_delta_row(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_project_maintenance_plan_delta_row(
  p_tenant_id bigint, p_site_id bigint, p_plan_id bigint
)
returns jsonb
language sql
stable
security definer
set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',p.id,
    'plan_id',p.id,
    'tenant_id',p.tenant_id,
    'site_id',p.site_id,
    'plan_code',p.plan_code,
    'generator_id',p.generator_id,
    'generator_name',g.name,
    'title',p.title,
    'description',p.description,
    'interval_days',p.interval_days,
    'interval_operating_hours',p.interval_operating_hours,
    'next_due_at',p.next_due_at,
    'next_due_operating_hours',p.next_due_operating_hours,
    'due_soon_days',p.due_soon_days,
    'due_soon_hours',p.due_soon_hours,
    'is_active',p.is_active,
    'last_completed_at',p.last_completed_at,
    'last_completed_operating_hours',p.last_completed_operating_hours,
    'alert_type',a.alert_type,
    'observed_operating_hours',g.operating_hours
  )
  from public.generator_maintenance_preventive_plans p
  join public.generators g
    on g.tenant_id=p.tenant_id and g.site_id=p.site_id and g.id=p.generator_id
  left join lateral (
    select e.alert_type
    from public.generator_maintenance_alert_events e
    where e.tenant_id=p.tenant_id and e.site_id=p.site_id and e.plan_id=p.id
      and e.alert_type in ('due_soon','overdue')
    order by e.updated_at desc,e.id desc
    limit 1
  ) a on true
  where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.id=p_plan_id
$$;
alter function public.powerhub_project_maintenance_plan_delta_row(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_project_maintenance_plan_delta_row(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_project_maintenance_plan_delta_row(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_append_operational_delta_sync_change(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_entity_id text,p_change_type text,p_row_data jsonb
)
returns bigint
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_cursor bigint; v_cutoff bigint;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
    or p_entity_type not in ('fuel_readings','maintenance_preventive_plans')
    or p_entity_id is null or length(p_entity_id) not between 1 and 100
    or p_change_type not in ('upsert','delete')
    or (p_change_type='upsert' and p_row_data is null)
    or (p_change_type='delete' and p_row_data is not null)
    or not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id)
  then raise exception 'POWERHUB_OPERATIONAL_DELTA_CHANGE_INVALID' using errcode='P0001'; end if;

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
alter function public.powerhub_append_operational_delta_sync_change(bigint,bigint,text,text,text,jsonb) owner to postgres;
revoke all on function public.powerhub_append_operational_delta_sync_change(bigint,bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_append_operational_delta_sync_change(bigint,bigint,text,text,text,jsonb) to service_role;

create or replace function public.powerhub_emit_operational_delta_sync_change(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_entity_id bigint
)
returns void
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_row jsonb;
begin
  if p_entity_type='fuel_readings' then
    v_row:=public.powerhub_project_fuel_reading_delta_row(p_tenant_id,p_site_id,p_entity_id);
  elsif p_entity_type='maintenance_preventive_plans' then
    v_row:=public.powerhub_project_maintenance_plan_delta_row(p_tenant_id,p_site_id,p_entity_id);
  else
    raise exception 'POWERHUB_OPERATIONAL_DELTA_ENTITY_UNSUPPORTED' using errcode='P0001';
  end if;

  if v_row is null then
    perform public.powerhub_append_operational_delta_sync_change(
      p_tenant_id,p_site_id,p_entity_type,p_entity_id::text,'delete',null
    );
  else
    perform public.powerhub_append_operational_delta_sync_change(
      p_tenant_id,p_site_id,p_entity_type,p_entity_id::text,'upsert',v_row
    );
  end if;
end $$;
alter function public.powerhub_emit_operational_delta_sync_change(bigint,bigint,text,bigint) owner to postgres;
revoke all on function public.powerhub_emit_operational_delta_sync_change(bigint,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_emit_operational_delta_sync_change(bigint,bigint,text,bigint) to service_role;

create or replace function public.powerhub_capture_operational_delta_sync_change()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_entity_type text;
begin
  v_entity_type:=case TG_TABLE_NAME
    when 'generator_fuel_readings' then 'fuel_readings'
    when 'generator_maintenance_preventive_plans' then 'maintenance_preventive_plans'
    else null end;
  if v_entity_type is null then
    raise exception 'POWERHUB_OPERATIONAL_DELTA_TABLE_UNSUPPORTED' using errcode='P0001';
  end if;

  if TG_OP='DELETE' then
    perform public.powerhub_append_operational_delta_sync_change(
      OLD.tenant_id,OLD.site_id,v_entity_type,OLD.id::text,'delete',null
    );
    return OLD;
  end if;

  if TG_OP='UPDATE' and to_jsonb(OLD) is not distinct from to_jsonb(NEW) then return NEW; end if;
  if TG_OP='UPDATE' and (OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id) then
    perform public.powerhub_append_operational_delta_sync_change(
      OLD.tenant_id,OLD.site_id,v_entity_type,OLD.id::text,'delete',null
    );
  end if;

  perform public.powerhub_emit_operational_delta_sync_change(NEW.tenant_id,NEW.site_id,v_entity_type,NEW.id);
  return NEW;
end $$;
alter function public.powerhub_capture_operational_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_operational_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_operational_delta_sync_change() to service_role;

create or replace function public.powerhub_refresh_operational_delta_after_generator_update()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_row record;
begin
  if OLD.name is not distinct from NEW.name and OLD.operating_hours is not distinct from NEW.operating_hours then
    return NEW;
  end if;
  for v_row in
    select r.id from public.generator_fuel_readings r
    where r.tenant_id=NEW.tenant_id and r.site_id=NEW.site_id and r.generator_id=NEW.id
    order by r.id
  loop
    perform public.powerhub_emit_operational_delta_sync_change(NEW.tenant_id,NEW.site_id,'fuel_readings',v_row.id);
  end loop;
  for v_row in
    select p.id from public.generator_maintenance_preventive_plans p
    where p.tenant_id=NEW.tenant_id and p.site_id=NEW.site_id and p.generator_id=NEW.id
    order by p.id
  loop
    perform public.powerhub_emit_operational_delta_sync_change(NEW.tenant_id,NEW.site_id,'maintenance_preventive_plans',v_row.id);
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_operational_delta_after_generator_update() owner to postgres;
revoke all on function public.powerhub_refresh_operational_delta_after_generator_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_operational_delta_after_generator_update() to service_role;

create or replace function public.powerhub_refresh_fuel_reading_delta_after_warehouse_update()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_row record;
begin
  if OLD.name is not distinct from NEW.name then return NEW; end if;
  for v_row in
    select r.id from public.generator_fuel_readings r
    where r.tenant_id=NEW.tenant_id and r.site_id=NEW.site_id and r.tank_warehouse_id=NEW.id
    order by r.id
  loop
    perform public.powerhub_emit_operational_delta_sync_change(NEW.tenant_id,NEW.site_id,'fuel_readings',v_row.id);
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_fuel_reading_delta_after_warehouse_update() owner to postgres;
revoke all on function public.powerhub_refresh_fuel_reading_delta_after_warehouse_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_fuel_reading_delta_after_warehouse_update() to service_role;

create or replace function public.powerhub_refresh_maintenance_plan_delta_after_alert_change()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
begin
  if TG_OP='DELETE' then
    perform public.powerhub_emit_operational_delta_sync_change(OLD.tenant_id,OLD.site_id,'maintenance_preventive_plans',OLD.plan_id);
    return OLD;
  end if;
  if TG_OP='UPDATE' and (
      OLD.tenant_id is distinct from NEW.tenant_id
      or OLD.site_id is distinct from NEW.site_id
      or OLD.plan_id is distinct from NEW.plan_id
  ) then
    perform public.powerhub_emit_operational_delta_sync_change(OLD.tenant_id,OLD.site_id,'maintenance_preventive_plans',OLD.plan_id);
  end if;
  perform public.powerhub_emit_operational_delta_sync_change(NEW.tenant_id,NEW.site_id,'maintenance_preventive_plans',NEW.plan_id);
  return NEW;
end $$;
alter function public.powerhub_refresh_maintenance_plan_delta_after_alert_change() owner to postgres;
revoke all on function public.powerhub_refresh_maintenance_plan_delta_after_alert_change() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_maintenance_plan_delta_after_alert_change() to service_role;

drop trigger if exists powerhub_delta_operational_readings on public.generator_fuel_readings;
create trigger powerhub_delta_operational_readings
  after insert or update or delete on public.generator_fuel_readings
  for each row execute function public.powerhub_capture_operational_delta_sync_change();

drop trigger if exists powerhub_delta_operational_maintenance_plans on public.generator_maintenance_preventive_plans;
create trigger powerhub_delta_operational_maintenance_plans
  after insert or update or delete on public.generator_maintenance_preventive_plans
  for each row execute function public.powerhub_capture_operational_delta_sync_change();

drop trigger if exists powerhub_delta_operational_generator_related_rows on public.generators;
create trigger powerhub_delta_operational_generator_related_rows
  after update of name,operating_hours on public.generators
  for each row execute function public.powerhub_refresh_operational_delta_after_generator_update();

drop trigger if exists powerhub_delta_operational_fuel_readings_after_warehouse_update on public.inventory_warehouses;
create trigger powerhub_delta_operational_fuel_readings_after_warehouse_update
  after update of name on public.inventory_warehouses
  for each row execute function public.powerhub_refresh_fuel_reading_delta_after_warehouse_update();

drop trigger if exists powerhub_delta_operational_maintenance_plans_after_alert_change on public.generator_maintenance_alert_events;
create trigger powerhub_delta_operational_maintenance_plans_after_alert_change
  after insert or update or delete on public.generator_maintenance_alert_events
  for each row execute function public.powerhub_refresh_maintenance_plan_delta_after_alert_change();

create or replace function public.powerhub_get_operational_sync_snapshot(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_cursor bigint:=0; v_retained bigint:=0; v_rows jsonb:='[]'::jsonb;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then
    raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if p_entity_type not in ('fuel_readings','maintenance_preventive_plans') then
    raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001';
  end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select s.last_cursor,s.retained_from_cursor into v_cursor,v_retained
    from public.powerhub_sync_scope_state s
    where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
  if not found then v_cursor:=0; v_retained:=0; end if;

  if p_entity_type='fuel_readings' then
    select coalesce(jsonb_agg(public.powerhub_project_fuel_reading_delta_row(p_tenant_id,p_site_id,r.id)
      order by r.recorded_at desc,r.id desc),'[]'::jsonb) into v_rows
    from (
      select id,recorded_at from public.generator_fuel_readings
      where tenant_id=p_tenant_id and site_id=p_site_id
      order by recorded_at desc,id desc limit 500
    ) r;
  elsif p_entity_type='maintenance_preventive_plans' then
    select coalesce(jsonb_agg(public.powerhub_project_maintenance_plan_delta_row(p_tenant_id,p_site_id,p.id)
      order by case when plan_row.alert_type='overdue' then 0 when plan_row.alert_type='due_soon' then 1 else 2 end,
        coalesce(p.next_due_at,'infinity'::timestamptz),p.id),'[]'::jsonb) into v_rows
    from public.generator_maintenance_preventive_plans p
    left join lateral (
      select e.alert_type from public.generator_maintenance_alert_events e
      where e.tenant_id=p.tenant_id and e.site_id=p.site_id and e.plan_id=p.id
        and e.alert_type in ('due_soon','overdue')
      order by e.updated_at desc,e.id desc limit 1
    ) plan_row on true
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id;
  end if;

  return jsonb_build_object('status','ok','entity_type',p_entity_type,
    'snapshot_cursor',v_cursor::text,'retained_from_cursor',v_retained::text,'rows',v_rows);
end $$;
alter function public.powerhub_get_operational_sync_snapshot(bigint,bigint,text) owner to postgres;
revoke all on function public.powerhub_get_operational_sync_snapshot(bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_get_operational_sync_snapshot(bigint,bigint,text) to service_role;

create or replace function public.powerhub_pull_operational_sync_delta(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_after_cursor bigint,p_through_cursor bigint default null,p_page_size integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_current bigint:=0; v_retained bigint:=0; v_target bigint:=0; v_next bigint:=0;
  v_last bigint; v_more boolean:=false; v_changes jsonb:='[]'::jsonb;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then
    raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if p_entity_type not in ('fuel_readings','maintenance_preventive_plans') then
    raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001';
  end if;
  if p_page_size is null or p_page_size<1 or p_page_size>500 then
    raise exception 'POWERHUB_SYNC_PAGE_SIZE_INVALID' using errcode='P0001';
  end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select s.last_cursor,s.retained_from_cursor into v_current,v_retained
    from public.powerhub_sync_scope_state s
    where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
  if not found then v_current:=0; v_retained:=0; end if;

  if p_after_cursor is null or p_after_cursor<v_retained then
    return jsonb_build_object('status','reset_required','entity_type',p_entity_type,
      'current_cursor',v_current::text,'retained_from_cursor',v_retained::text,
      'snapshot_cursor',v_current::text,'through_cursor',v_current::text,
      'next_cursor',null,'has_more',false,'changes','[]'::jsonb);
  end if;
  if p_after_cursor<0 or p_after_cursor>v_current then
    raise exception 'POWERHUB_SYNC_CURSOR_INVALID' using errcode='P0001';
  end if;
  if p_through_cursor is null then v_target:=v_current;
  else
    v_target:=p_through_cursor;
    if v_target<p_after_cursor or v_target>v_current then
      raise exception 'POWERHUB_SYNC_TARGET_CURSOR_INVALID' using errcode='P0001';
    end if;
  end if;

  with page_rows as (
    select c.cursor,c.entity_type,c.entity_id,c.change_type,c.row_data,c.changed_at
    from public.powerhub_sync_changes c
    where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type
      and c.cursor>p_after_cursor and c.cursor<=v_target
    order by c.cursor limit p_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object('cursor',p.cursor::text,'entity_type',p.entity_type,
    'entity_id',p.entity_id,'operation',p.change_type,'row_data',p.row_data,'changed_at',p.changed_at)
    order by p.cursor),'[]'::jsonb),max(p.cursor)
  into v_changes,v_last from page_rows p;

  select exists(
    select 1 from public.powerhub_sync_changes c
    where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type
      and c.cursor>coalesce(v_last,p_after_cursor) and c.cursor<=v_target
  ) into v_more;
  if v_more then v_next:=coalesce(v_last,p_after_cursor); else v_next:=v_target; end if;

  return jsonb_build_object('status','ok','entity_type',p_entity_type,'current_cursor',v_current::text,
    'retained_from_cursor',v_retained::text,'snapshot_cursor',null,'through_cursor',v_target::text,
    'next_cursor',v_next::text,'has_more',v_more,'changes',v_changes);
end $$;
alter function public.powerhub_pull_operational_sync_delta(bigint,bigint,text,bigint,bigint,integer) owner to postgres;
revoke all on function public.powerhub_pull_operational_sync_delta(bigint,bigint,text,bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_pull_operational_sync_delta(bigint,bigint,text,bigint,bigint,integer) to service_role;
