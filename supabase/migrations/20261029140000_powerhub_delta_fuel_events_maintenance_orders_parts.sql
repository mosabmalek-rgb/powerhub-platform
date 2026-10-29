-- Scoped Delta feeds for fuel-fill events, maintenance work orders, and per-order parts.
-- Work-order parts use a work-order-partitioned entity type so one order's full parts
-- list does not compete with every other order in a site-wide retention window.
-- Report aggregates remain in the separately filtered, permission-checked report cache.

alter table public.powerhub_sync_scope_state
  drop constraint if exists powerhub_sync_scope_state_entity_type_check;
alter table public.powerhub_sync_scope_state
  add constraint powerhub_sync_scope_state_entity_type_check
  check (
    entity_type in (
      'sites','subscribers','generators','readings','tariffs','invoices','payments','expenses',
      'company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers',
      'inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers',
      'inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings',
      'maintenance_preventive_plans','fuel_events','maintenance_work_orders'
    )
    or entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$'
  );

alter table public.powerhub_sync_changes
  drop constraint if exists powerhub_sync_changes_entity_type_check;
alter table public.powerhub_sync_changes
  add constraint powerhub_sync_changes_entity_type_check
  check (
    entity_type in (
      'sites','subscribers','generators','readings','tariffs','invoices','payments','expenses',
      'company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers',
      'inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers',
      'inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings',
      'maintenance_preventive_plans','fuel_events','maintenance_work_orders'
    )
    or entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$'
  );

create or replace function public.powerhub_project_fuel_event_delta_row(
  p_tenant_id bigint,p_site_id bigint,p_event_id bigint
)
returns jsonb
language sql stable security definer
set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',e.id,'event_id',e.id,'tenant_id',e.tenant_id,'site_id',e.site_id,
    'generator_id',e.generator_id,'generator_name',g.name,
    'fuel_item_id',e.fuel_item_id,'fuel_item_name',i.name,
    'source_warehouse_id',e.source_warehouse_id,'source_warehouse_name',sw.name,
    'destination_warehouse_id',e.destination_warehouse_id,'destination_warehouse_name',dw.name,
    'litres',e.litres,'occurred_at',e.occurred_at,
    'level_before_liters',e.level_before_liters,'level_after_liters',e.level_after_liters,
    'operating_hours',e.operating_hours,'reference_no',e.reference_no,'notes',null,
    'stock_transfer_id',e.stock_transfer_id,'created_by_user_id',null,'created_at',e.created_at
  )
  from public.generator_fuel_events e
  join public.generators g on g.tenant_id=e.tenant_id and g.site_id=e.site_id and g.id=e.generator_id
  join public.inventory_items i on i.tenant_id=e.tenant_id and i.id=e.fuel_item_id
  join public.inventory_warehouses sw on sw.tenant_id=e.tenant_id and sw.site_id=e.site_id and sw.id=e.source_warehouse_id
  join public.inventory_warehouses dw on dw.tenant_id=e.tenant_id and dw.site_id=e.site_id and dw.id=e.destination_warehouse_id
  where e.tenant_id=p_tenant_id and e.site_id=p_site_id and e.id=p_event_id
$$;
alter function public.powerhub_project_fuel_event_delta_row(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_project_fuel_event_delta_row(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_project_fuel_event_delta_row(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_project_maintenance_work_order_delta_row(
  p_tenant_id bigint,p_site_id bigint,p_work_order_id bigint
)
returns jsonb
language sql stable security definer
set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',w.id,'work_order_id',w.id,'tenant_id',w.tenant_id,'site_id',w.site_id,
    'work_order_number',w.work_order_number,'generator_id',w.generator_id,'generator_name',g.name,
    'preventive_plan_id',w.preventive_plan_id,'order_type',w.order_type,'priority',w.priority,'status',w.status,
    'title',w.title,'description',w.description,'work_summary',w.work_summary,
    'reported_at',w.reported_at,'scheduled_for',w.scheduled_for,'started_at',w.started_at,'completed_at',w.completed_at,
    'assigned_to_user_id',w.assigned_to_user_id,'assigned_supplier_id',w.assigned_supplier_id,
    'assigned_supplier_name',s.name,'assigned_supplier_code',s.supplier_code,
    'operating_hours_at_open',w.operating_hours_at_open,'operating_hours_at_close',w.operating_hours_at_close,
    'downtime_minutes',w.downtime_minutes,'labor_cost',w.labor_cost,
    'external_service_cost',w.external_service_cost,'parts_cost',w.parts_cost,'total_cost_amount',w.total_cost_amount,
    'created_by_user_id',null
  )
  from public.generator_maintenance_work_orders w
  join public.generators g on g.tenant_id=w.tenant_id and g.site_id=w.site_id and g.id=w.generator_id
  left join public.suppliers s on s.tenant_id=w.tenant_id and s.id=w.assigned_supplier_id
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_work_order_id
$$;
alter function public.powerhub_project_maintenance_work_order_delta_row(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_project_maintenance_work_order_delta_row(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_project_maintenance_work_order_delta_row(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_project_maintenance_work_order_part_delta_row(
  p_tenant_id bigint,p_site_id bigint,p_work_order_id bigint,p_part_id bigint
)
returns jsonb
language sql stable security definer
set search_path=pg_catalog,public,pg_temp
as $$
  select jsonb_build_object(
    'id',p.id,'part_id',p.id,'tenant_id',p.tenant_id,'site_id',p.site_id,
    'work_order_id',p.work_order_id,'generator_id',p.generator_id,
    'item_id',p.item_id,'item_name',i.name,'category',i.category,
    'warehouse_id',p.warehouse_id,'warehouse_name',w.name,
    'quantity',p.quantity,'unit_cost',p.unit_cost,'total_cost_amount',p.total_cost_amount,
    'stock_movement_id',p.stock_movement_id,'issued_at',p.issued_at,'notes',null
  )
  from public.generator_maintenance_work_order_parts p
  join public.generator_maintenance_work_orders o
    on o.tenant_id=p.tenant_id and o.site_id=p.site_id and o.id=p.work_order_id
  join public.inventory_items i on i.tenant_id=p.tenant_id and i.id=p.item_id
  join public.inventory_warehouses w on w.tenant_id=p.tenant_id and w.site_id=p.site_id and w.id=p.warehouse_id
  where p.tenant_id=p_tenant_id and p.site_id=p_site_id
    and p.work_order_id=p_work_order_id and p.id=p_part_id
$$;
alter function public.powerhub_project_maintenance_work_order_part_delta_row(bigint,bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_project_maintenance_work_order_part_delta_row(bigint,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_project_maintenance_work_order_part_delta_row(bigint,bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_append_fuel_maintenance_delta_sync_change(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_entity_id text,p_change_type text,p_row_data jsonb
)
returns bigint
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_cursor bigint; v_cutoff bigint;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
    or not (
      p_entity_type in ('fuel_events','maintenance_work_orders')
      or p_entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$'
    )
    or p_entity_id is null or length(p_entity_id) not between 1 and 100
    or p_change_type not in ('upsert','delete')
    or (p_change_type='upsert' and (p_row_data is null or p_row_data->>'id' is distinct from p_entity_id))
    or (p_change_type='delete' and p_row_data is not null)
    or (p_change_type='upsert' and not exists(
      select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id
    ))
  then raise exception 'POWERHUB_FUEL_MAINTENANCE_DELTA_INVALID' using errcode='P0001'; end if;

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
alter function public.powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb) owner to postgres;
revoke all on function public.powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_append_fuel_maintenance_delta_sync_change(bigint,bigint,text,text,text,jsonb) to service_role;

create or replace function public.powerhub_emit_fuel_maintenance_delta_sync_change(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_entity_id bigint
)
returns void
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_row jsonb; v_work_order_id bigint;
begin
  if p_entity_type='fuel_events' then
    v_row:=public.powerhub_project_fuel_event_delta_row(p_tenant_id,p_site_id,p_entity_id);
  elsif p_entity_type='maintenance_work_orders' then
    v_row:=public.powerhub_project_maintenance_work_order_delta_row(p_tenant_id,p_site_id,p_entity_id);
  elsif p_entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$' then
    v_work_order_id:=substring(p_entity_type from '^maintenance_work_order_parts:([1-9][0-9]{0,15})$')::bigint;
    v_row:=public.powerhub_project_maintenance_work_order_part_delta_row(p_tenant_id,p_site_id,v_work_order_id,p_entity_id);
  else
    raise exception 'POWERHUB_FUEL_MAINTENANCE_ENTITY_UNSUPPORTED' using errcode='P0001';
  end if;
  if v_row is null then
    perform public.powerhub_append_fuel_maintenance_delta_sync_change(
      p_tenant_id,p_site_id,p_entity_type,p_entity_id::text,'delete',null
    );
  else
    perform public.powerhub_append_fuel_maintenance_delta_sync_change(
      p_tenant_id,p_site_id,p_entity_type,p_entity_id::text,'upsert',v_row
    );
  end if;
end $$;
alter function public.powerhub_emit_fuel_maintenance_delta_sync_change(bigint,bigint,text,bigint) owner to postgres;
revoke all on function public.powerhub_emit_fuel_maintenance_delta_sync_change(bigint,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_emit_fuel_maintenance_delta_sync_change(bigint,bigint,text,bigint) to service_role;

-- Re-emit the current top-200 work orders when a row leaves or changes position
-- in this bounded feed. A tombstone/upsert alone cannot reveal row #201.
create or replace function public.powerhub_refresh_maintenance_work_order_delta_scope(
  p_tenant_id bigint,p_site_id bigint
)
returns void
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $
declare v_order record;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then
    raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  for v_order in
    select visible.id from (
      select w.id
      from public.generator_maintenance_work_orders w
      where w.tenant_id=p_tenant_id and w.site_id=p_site_id
      order by coalesce(w.reported_at,w.created_at) desc,w.id desc
      limit 200
    ) visible
    order by visible.id
  loop
    perform public.powerhub_emit_fuel_maintenance_delta_sync_change(
      p_tenant_id,p_site_id,'maintenance_work_orders',v_order.id
    );
  end loop;
end $;
alter function public.powerhub_refresh_maintenance_work_order_delta_scope(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_maintenance_work_order_delta_scope(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_maintenance_work_order_delta_scope(bigint,bigint) to service_role;

create or replace function public.powerhub_capture_fuel_maintenance_delta_sync_change()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_entity_type text; v_old_entity_type text; v_old_id bigint; v_scope_changed boolean:=false;
begin
  if TG_TABLE_NAME='generator_fuel_events' then
    v_entity_type:='fuel_events';
  elsif TG_TABLE_NAME='generator_maintenance_work_orders' then
    v_entity_type:='maintenance_work_orders';
  elsif TG_TABLE_NAME='generator_maintenance_work_order_parts' then
    if TG_OP='DELETE' then
      v_entity_type:='maintenance_work_order_parts:'||OLD.work_order_id::text;
    else
      v_entity_type:='maintenance_work_order_parts:'||NEW.work_order_id::text;
    end if;
  else
    raise exception 'POWERHUB_FUEL_MAINTENANCE_TABLE_UNSUPPORTED' using errcode='P0001';
  end if;

  if TG_OP='DELETE' then
    perform public.powerhub_append_fuel_maintenance_delta_sync_change(
      OLD.tenant_id,OLD.site_id,v_entity_type,OLD.id::text,'delete',null
    );
    if TG_TABLE_NAME='generator_maintenance_work_orders' then
      -- Fill the slot vacated in the bounded top-200 after deleting a visible row.
      perform public.powerhub_refresh_maintenance_work_order_delta_scope(OLD.tenant_id,OLD.site_id);
    end if;
    return OLD;
  end if;

  if TG_OP='UPDATE' and to_jsonb(OLD) is not distinct from to_jsonb(NEW) then return NEW; end if;

  if TG_OP='UPDATE' then
    if OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id then
      v_scope_changed:=true;
    elsif TG_TABLE_NAME='generator_maintenance_work_order_parts' then
      -- Keep record-field access inside the matching table branch: OLD on a fuel
      -- event or work order does not have a work_order_id field.
      v_scope_changed:=OLD.work_order_id is distinct from NEW.work_order_id;
    end if;
  end if;

  if v_scope_changed then
    if TG_TABLE_NAME='generator_maintenance_work_order_parts' then
      v_old_entity_type:='maintenance_work_order_parts:'||OLD.work_order_id::text;
    else
      v_old_entity_type:=v_entity_type;
    end if;
    perform public.powerhub_append_fuel_maintenance_delta_sync_change(
      OLD.tenant_id,OLD.site_id,v_old_entity_type,OLD.id::text,'delete',null
    );
    if TG_TABLE_NAME='generator_maintenance_work_orders' then
      -- A move to another tenant/site must also refill the old scope's bounded list.
      perform public.powerhub_refresh_maintenance_work_order_delta_scope(OLD.tenant_id,OLD.site_id);
    end if;
  end if;

  perform public.powerhub_emit_fuel_maintenance_delta_sync_change(
    NEW.tenant_id,NEW.site_id,v_entity_type,NEW.id
  );
  if TG_OP='UPDATE' and TG_TABLE_NAME='generator_maintenance_work_orders'
    and OLD.reported_at is distinct from NEW.reported_at then
    -- The changed order may have crossed the top-200 boundary; emit its replacement set.
    perform public.powerhub_refresh_maintenance_work_order_delta_scope(NEW.tenant_id,NEW.site_id);
  end if;
  return NEW;
end $$;
alter function public.powerhub_capture_fuel_maintenance_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_fuel_maintenance_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_fuel_maintenance_delta_sync_change() to service_role;

create or replace function public.powerhub_get_fuel_maintenance_sync_snapshot(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text
)
returns jsonb
language plpgsql stable security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_cursor bigint:=0; v_retained bigint:=0; v_rows jsonb:='[]'::jsonb; v_work_order_id bigint;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then
    raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if not (
    p_entity_type in ('fuel_events','maintenance_work_orders')
    or p_entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$'
  ) then raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001'; end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_entity_type like 'maintenance_work_order_parts:%' then
    v_work_order_id:=substring(p_entity_type from '^maintenance_work_order_parts:([1-9][0-9]{0,15})$')::bigint;
    if not exists(select 1 from public.generator_maintenance_work_orders w
      where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=v_work_order_id) then
      raise exception 'POWERHUB_SYNC_WORK_ORDER_OUT_OF_SCOPE' using errcode='P0001';
    end if;
  end if;
  select s.last_cursor,s.retained_from_cursor into v_cursor,v_retained
    from public.powerhub_sync_scope_state s
    where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
  if not found then v_cursor:=0; v_retained:=0; end if;

  if p_entity_type='fuel_events' then
    select coalesce(jsonb_agg(public.powerhub_project_fuel_event_delta_row(p_tenant_id,p_site_id,r.id)
      order by r.occurred_at desc,r.id desc),'[]'::jsonb) into v_rows
    from (
      select e.id,e.occurred_at from public.generator_fuel_events e
      where e.tenant_id=p_tenant_id and e.site_id=p_site_id
      order by e.occurred_at desc,e.id desc limit 500
    ) r;
  elsif p_entity_type='maintenance_work_orders' then
    select coalesce(jsonb_agg(public.powerhub_project_maintenance_work_order_delta_row(p_tenant_id,p_site_id,r.id)
      order by r.reported_at desc,r.id desc),'[]'::jsonb) into v_rows
    from (
      select w.id,coalesce(w.reported_at,w.created_at) as reported_at
      from public.generator_maintenance_work_orders w
      where w.tenant_id=p_tenant_id and w.site_id=p_site_id
      order by coalesce(w.reported_at,w.created_at) desc,w.id desc limit 200
    ) r;
  elsif p_entity_type like 'maintenance_work_order_parts:%' then
    select coalesce(jsonb_agg(public.powerhub_project_maintenance_work_order_part_delta_row(
      p_tenant_id,p_site_id,v_work_order_id,p.id
    ) order by p.issued_at,p.id),'[]'::jsonb) into v_rows
    from public.generator_maintenance_work_order_parts p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.work_order_id=v_work_order_id;
  end if;
  return jsonb_build_object('status','ok','entity_type',p_entity_type,
    'snapshot_cursor',v_cursor::text,'retained_from_cursor',v_retained::text,'rows',v_rows);
end $$;
alter function public.powerhub_get_fuel_maintenance_sync_snapshot(bigint,bigint,text) owner to postgres;
revoke all on function public.powerhub_get_fuel_maintenance_sync_snapshot(bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_get_fuel_maintenance_sync_snapshot(bigint,bigint,text) to service_role;

create or replace function public.powerhub_pull_fuel_maintenance_sync_delta(
  p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_after_cursor bigint,
  p_through_cursor bigint default null,p_page_size integer default 200
)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare
  v_current bigint:=0; v_retained bigint:=0; v_target bigint:=0; v_next bigint:=0;
  v_last bigint; v_more boolean:=false; v_changes jsonb:='[]'::jsonb;
  v_work_order_id bigint;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then
    raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001';
  end if;
  if not (
    p_entity_type in ('fuel_events','maintenance_work_orders')
    or p_entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$'
  ) then raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001'; end if;
  if p_page_size is null or p_page_size<1 or p_page_size>500 then
    raise exception 'POWERHUB_SYNC_PAGE_SIZE_INVALID' using errcode='P0001';
  end if;
  if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_entity_type like 'maintenance_work_order_parts:%' then
    v_work_order_id:=substring(p_entity_type from '^maintenance_work_order_parts:([1-9][0-9]{0,15})$')::bigint;
    if not exists(select 1 from public.generator_maintenance_work_orders w
      where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=v_work_order_id) then
      raise exception 'POWERHUB_SYNC_WORK_ORDER_OUT_OF_SCOPE' using errcode='P0001';
    end if;
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
  select coalesce(jsonb_agg(jsonb_build_object(
    'cursor',p.cursor::text,'entity_type',p.entity_type,'entity_id',p.entity_id,
    'operation',p.change_type,'row_data',p.row_data,'changed_at',p.changed_at
  ) order by p.cursor),'[]'::jsonb),max(p.cursor)
  into v_changes,v_last from page_rows p;

  select exists(
    select 1 from public.powerhub_sync_changes c
    where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type
      and c.cursor>coalesce(v_last,p_after_cursor) and c.cursor<=v_target
  ) into v_more;
  if v_more then v_next:=coalesce(v_last,p_after_cursor); else v_next:=v_target; end if;

  return jsonb_build_object(
    'status','ok','entity_type',p_entity_type,'current_cursor',v_current::text,
    'retained_from_cursor',v_retained::text,'snapshot_cursor',null,
    'through_cursor',v_target::text,'next_cursor',v_next::text,'has_more',v_more,'changes',v_changes
  );
end $$;
alter function public.powerhub_pull_fuel_maintenance_sync_delta(bigint,bigint,text,bigint,bigint,integer) owner to postgres;
revoke all on function public.powerhub_pull_fuel_maintenance_sync_delta(bigint,bigint,text,bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_pull_fuel_maintenance_sync_delta(bigint,bigint,text,bigint,bigint,integer) to service_role;

create or replace function public.powerhub_refresh_fuel_maintenance_delta_after_generator_name_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_row record;
begin
  if OLD.name is not distinct from NEW.name then return NEW; end if;
  for v_row in
    select visible.id from (
      select e.id,e.generator_id from public.generator_fuel_events e
      where e.tenant_id=NEW.tenant_id and e.site_id=NEW.site_id
      order by e.occurred_at desc,e.id desc limit 500
    ) visible
    where visible.generator_id=NEW.id order by visible.id
  loop
    perform public.powerhub_emit_fuel_maintenance_delta_sync_change(NEW.tenant_id,NEW.site_id,'fuel_events',v_row.id);
  end loop;
  for v_row in
    select visible.id from (
      select w.id,w.generator_id from public.generator_maintenance_work_orders w
      where w.tenant_id=NEW.tenant_id and w.site_id=NEW.site_id
      order by coalesce(w.reported_at,w.created_at) desc,w.id desc limit 200
    ) visible
    where visible.generator_id=NEW.id order by visible.id
  loop
    perform public.powerhub_emit_fuel_maintenance_delta_sync_change(NEW.tenant_id,NEW.site_id,'maintenance_work_orders',v_row.id);
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_fuel_maintenance_delta_after_generator_name_update() owner to postgres;
revoke all on function public.powerhub_refresh_fuel_maintenance_delta_after_generator_name_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_fuel_maintenance_delta_after_generator_name_update() to service_role;

create or replace function public.powerhub_refresh_fuel_event_delta_after_warehouse_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_row record;
begin
  if OLD.name is not distinct from NEW.name then return NEW; end if;
  for v_row in
    select visible.id from (
      select e.id,e.source_warehouse_id,e.destination_warehouse_id
      from public.generator_fuel_events e
      where e.tenant_id=NEW.tenant_id and e.site_id=NEW.site_id
      order by e.occurred_at desc,e.id desc limit 500
    ) visible
    where visible.source_warehouse_id=NEW.id or visible.destination_warehouse_id=NEW.id
    order by visible.id
  loop
    perform public.powerhub_emit_fuel_maintenance_delta_sync_change(NEW.tenant_id,NEW.site_id,'fuel_events',v_row.id);
  end loop;
  for v_row in
    select distinct visible.work_order_id from (
      select w.id from public.generator_maintenance_work_orders w
      where w.tenant_id=NEW.tenant_id and w.site_id=NEW.site_id
      order by coalesce(w.reported_at,w.created_at) desc,w.id desc limit 200
    ) orders
    join public.generator_maintenance_work_order_parts visible
      on visible.tenant_id=NEW.tenant_id and visible.site_id=NEW.site_id and visible.work_order_id=orders.id
    where visible.warehouse_id=NEW.id
  loop
    perform public.powerhub_refresh_maintenance_part_delta_order(NEW.tenant_id,NEW.site_id,v_row.work_order_id);
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_fuel_event_delta_after_warehouse_update() owner to postgres;
revoke all on function public.powerhub_refresh_fuel_event_delta_after_warehouse_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_fuel_event_delta_after_warehouse_update() to service_role;

create or replace function public.powerhub_refresh_fuel_event_delta_after_item_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_scope record; v_row record;
begin
  if OLD.name is not distinct from NEW.name and OLD.category is not distinct from NEW.category then return NEW; end if;
  for v_scope in
    select distinct e.site_id from public.generator_fuel_events e
    where e.tenant_id=NEW.tenant_id and e.fuel_item_id=NEW.id
  loop
    for v_row in
      select visible.id from (
        select e.id,e.fuel_item_id from public.generator_fuel_events e
        where e.tenant_id=NEW.tenant_id and e.site_id=v_scope.site_id
        order by e.occurred_at desc,e.id desc limit 500
      ) visible where visible.fuel_item_id=NEW.id order by visible.id
    loop
      perform public.powerhub_emit_fuel_maintenance_delta_sync_change(NEW.tenant_id,v_scope.site_id,'fuel_events',v_row.id);
    end loop;
  end loop;
  for v_scope in
    select distinct p.site_id,p.work_order_id
    from public.generator_maintenance_work_order_parts p
    join (
      select w.id,w.tenant_id,w.site_id,
        row_number() over(partition by w.tenant_id,w.site_id order by coalesce(w.reported_at,w.created_at) desc,w.id desc) as position
      from public.generator_maintenance_work_orders w
      where w.tenant_id=NEW.tenant_id
    ) visible on visible.tenant_id=p.tenant_id and visible.site_id=p.site_id and visible.id=p.work_order_id and visible.position<=200
    where p.tenant_id=NEW.tenant_id and p.item_id=NEW.id
  loop
    perform public.powerhub_refresh_maintenance_part_delta_order(NEW.tenant_id,v_scope.site_id,v_scope.work_order_id);
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_fuel_event_delta_after_item_update() owner to postgres;
revoke all on function public.powerhub_refresh_fuel_event_delta_after_item_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_fuel_event_delta_after_item_update() to service_role;

create or replace function public.powerhub_refresh_maintenance_part_delta_order(
  p_tenant_id bigint,p_site_id bigint,p_work_order_id bigint
)
returns void
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_part record;
begin
  if not exists(select 1 from public.generator_maintenance_work_orders w
    where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_work_order_id) then return; end if;
  for v_part in
    select p.id from public.generator_maintenance_work_order_parts p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id and p.work_order_id=p_work_order_id
    order by p.issued_at,p.id
  loop
    perform public.powerhub_emit_fuel_maintenance_delta_sync_change(
      p_tenant_id,p_site_id,'maintenance_work_order_parts:'||p_work_order_id::text,v_part.id
    );
  end loop;
end $$;
alter function public.powerhub_refresh_maintenance_part_delta_order(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_maintenance_part_delta_order(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_maintenance_part_delta_order(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_refresh_maintenance_part_delta_after_warehouse_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_scope record;
begin
  if OLD.name is not distinct from NEW.name then return NEW; end if;
  for v_scope in
    select distinct visible.site_id,p.work_order_id
    from (
      select w.id,w.site_id from public.generator_maintenance_work_orders w
      where w.tenant_id=NEW.tenant_id and w.site_id=NEW.site_id
      order by coalesce(w.reported_at,w.created_at) desc,w.id desc limit 200
    ) visible
    join public.generator_maintenance_work_order_parts p
      on p.tenant_id=NEW.tenant_id and p.site_id=NEW.site_id
      and p.work_order_id=visible.id and p.warehouse_id=NEW.id
  loop
    perform public.powerhub_refresh_maintenance_part_delta_order(NEW.tenant_id,v_scope.site_id,v_scope.work_order_id);
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_maintenance_part_delta_after_warehouse_update() owner to postgres;
revoke all on function public.powerhub_refresh_maintenance_part_delta_after_warehouse_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_maintenance_part_delta_after_warehouse_update() to service_role;

create or replace function public.powerhub_refresh_maintenance_order_delta_after_supplier_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_scope record; v_order record;
begin
  if OLD.name is not distinct from NEW.name and OLD.supplier_code is not distinct from NEW.supplier_code then return NEW; end if;
  for v_scope in
    select distinct w.site_id from public.generator_maintenance_work_orders w
    where w.tenant_id=NEW.tenant_id and w.assigned_supplier_id=NEW.id
  loop
    for v_order in
      select visible.id from (
        select w.id,w.assigned_supplier_id from public.generator_maintenance_work_orders w
        where w.tenant_id=NEW.tenant_id and w.site_id=v_scope.site_id
        order by coalesce(w.reported_at,w.created_at) desc,w.id desc limit 200
      ) visible where visible.assigned_supplier_id=NEW.id order by visible.id
    loop
      perform public.powerhub_emit_fuel_maintenance_delta_sync_change(NEW.tenant_id,v_scope.site_id,'maintenance_work_orders',v_order.id);
    end loop;
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_maintenance_order_delta_after_supplier_update() owner to postgres;
revoke all on function public.powerhub_refresh_maintenance_order_delta_after_supplier_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_maintenance_order_delta_after_supplier_update() to service_role;

drop trigger if exists powerhub_delta_fuel_events_operational on public.generator_fuel_events;
create trigger powerhub_delta_fuel_events_operational
  after insert or update or delete on public.generator_fuel_events
  for each row execute function public.powerhub_capture_fuel_maintenance_delta_sync_change();

drop trigger if exists powerhub_delta_maintenance_work_orders_operational on public.generator_maintenance_work_orders;
create trigger powerhub_delta_maintenance_work_orders_operational
  after insert or update or delete on public.generator_maintenance_work_orders
  for each row execute function public.powerhub_capture_fuel_maintenance_delta_sync_change();

drop trigger if exists powerhub_delta_maintenance_work_order_parts_operational on public.generator_maintenance_work_order_parts;
create trigger powerhub_delta_maintenance_work_order_parts_operational
  after insert or update or delete on public.generator_maintenance_work_order_parts
  for each row execute function public.powerhub_capture_fuel_maintenance_delta_sync_change();

drop trigger if exists powerhub_delta_fuel_maintenance_generator_name on public.generators;
create trigger powerhub_delta_fuel_maintenance_generator_name
  after update of name on public.generators
  for each row execute function public.powerhub_refresh_fuel_maintenance_delta_after_generator_name_update();

drop trigger if exists powerhub_delta_fuel_event_warehouse_name on public.inventory_warehouses;
create trigger powerhub_delta_fuel_event_warehouse_name
  after update of name on public.inventory_warehouses
  for each row execute function public.powerhub_refresh_fuel_event_delta_after_warehouse_update();

drop trigger if exists powerhub_delta_maintenance_part_warehouse_name on public.inventory_warehouses;
create trigger powerhub_delta_maintenance_part_warehouse_name
  after update of name on public.inventory_warehouses
  for each row execute function public.powerhub_refresh_maintenance_part_delta_after_warehouse_update();

drop trigger if exists powerhub_delta_fuel_event_item_name on public.inventory_items;
create trigger powerhub_delta_fuel_event_item_name
  after update of name,category on public.inventory_items
  for each row execute function public.powerhub_refresh_fuel_event_delta_after_item_update();

drop trigger if exists powerhub_delta_maintenance_order_supplier_name on public.suppliers;
create trigger powerhub_delta_maintenance_order_supplier_name
  after update of name,supplier_code on public.suppliers
  for each row execute function public.powerhub_refresh_maintenance_order_delta_after_supplier_update();
