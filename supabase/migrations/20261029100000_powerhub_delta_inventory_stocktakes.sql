-- Branch-scoped Delta feed for stocktake headers and server-derived non-financial counters only.
-- Count-line values and costs remain server-only and are never projected to the local cache.

alter table public.powerhub_sync_scope_state drop constraint if exists powerhub_sync_scope_state_entity_type_check;
alter table public.powerhub_sync_scope_state add constraint powerhub_sync_scope_state_entity_type_check
  check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices','payments','expenses','company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements','inventory_stocktakes'));
alter table public.powerhub_sync_changes drop constraint if exists powerhub_sync_changes_entity_type_check;
alter table public.powerhub_sync_changes add constraint powerhub_sync_changes_entity_type_check
  check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices','payments','expenses','company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements','inventory_stocktakes'));

create or replace function public.powerhub_delta_sync_project_stocktake_row(p_row jsonb)
returns jsonb language sql stable set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object(
    'id',st.id,'stocktake_id',st.id,'tenant_id',st.tenant_id,'site_id',st.site_id,
    'stocktake_number',st.stocktake_number,'warehouse_id',st.warehouse_id,
    'warehouse_name',w.name,'location_type',w.location_type,
    'status',st.status,'reason',st.reason,'notes',st.notes,
    'snapshot_at',st.snapshot_at,'created_at',st.created_at,'created_by_user_id',st.created_by_user_id,
    'submitted_at',st.submitted_at,'submitted_by_user_id',st.submitted_by_user_id,
    'posted_at',st.posted_at,'posted_by_user_id',st.posted_by_user_id,
    'item_count',counts.item_count,'counted_count',counts.counted_count,
    'variance_count',counts.variance_count,'variance_quantity',counts.variance_quantity
  )
  from public.inventory_stocktakes st
  join public.inventory_warehouses w
    on w.tenant_id=st.tenant_id and w.site_id=st.site_id and w.id=st.warehouse_id
  left join lateral (
    select count(l.id)::integer as item_count,
      count(l.id) filter (where l.counted_quantity is not null)::integer as counted_count,
      count(l.id) filter (where l.variance_quantity<>0)::integer as variance_count,
      coalesce(sum(l.variance_quantity),0)::numeric(14,3) as variance_quantity
    from public.inventory_stocktake_lines l
    where l.tenant_id=st.tenant_id and l.stocktake_id=st.id
  ) counts on true
  where st.tenant_id=nullif(p_row->>'tenant_id','')::bigint
    and st.id=nullif(p_row->>'id','')::bigint
$$;
alter function public.powerhub_delta_sync_project_stocktake_row(jsonb) owner to postgres;
revoke all on function public.powerhub_delta_sync_project_stocktake_row(jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_delta_sync_project_stocktake_row(jsonb) to service_role;

create or replace function public.powerhub_delta_sync_project_inventory_row(p_entity_type text,p_row jsonb)
returns jsonb language sql stable set search_path=pg_catalog,public,pg_temp as $$
 select case p_entity_type
 when 'inventory_items' then jsonb_build_object('id',p_row->'id','tenant_id',p_row->'tenant_id','sku',p_row->'sku','name',p_row->'name','category',p_row->'category','base_unit',p_row->'base_unit','reorder_point',p_row->'reorder_point','specification',p_row->'specification','notes',p_row->'notes','is_active',p_row->'is_active','created_at',p_row->'created_at','updated_at',p_row->'updated_at')
 when 'inventory_item_units' then jsonb_build_object('id',p_row->'id','tenant_id',p_row->'tenant_id','item_id',p_row->'item_id','unit_label',p_row->'unit_label','factor_to_base',p_row->'factor_to_base','is_active',p_row->'is_active','created_at',p_row->'created_at','updated_at',p_row->'updated_at')
 when 'suppliers' then jsonb_build_object('id',p_row->'id','tenant_id',p_row->'tenant_id','supplier_code',p_row->'supplier_code','name',p_row->'name','contact_name',p_row->'contact_name','phone',p_row->'phone','email',p_row->'email','address',p_row->'address','tax_number',p_row->'tax_number','default_payment_terms_days',p_row->'default_payment_terms_days','supplier_type',p_row->'supplier_type','notes',p_row->'notes','is_active',p_row->'is_active','created_at',p_row->'created_at','updated_at',p_row->'updated_at')
 when 'inventory_warehouses' then jsonb_build_object('id',p_row->'id','tenant_id',p_row->'tenant_id','site_id',p_row->'site_id','code',p_row->'code','name',p_row->'name','notes',p_row->'notes','is_active',p_row->'is_active','location_type',p_row->'location_type','generator_id',p_row->'generator_id','created_at',p_row->'created_at','updated_at',p_row->'updated_at')
 when 'inventory_stock_movements' then (
   select jsonb_build_object(
     'id',p_row->'id','movement_id',p_row->'id',
     'tenant_id',p_row->'tenant_id','site_id',p_row->'site_id',
     'warehouse_id',p_row->'warehouse_id','warehouse_code',w.code,'warehouse_name',w.name,
     'item_id',p_row->'item_id','sku',i.sku,'item_name',i.name,'category',i.category,'base_unit',i.base_unit,
     'generator_id',p_row->'generator_id','movement_type',p_row->'movement_type',
     'quantity',p_row->'quantity','reference_no',p_row->'reference_no','notes',p_row->'notes',
     'operation_key',p_row->'operation_key','occurred_at',p_row->'occurred_at',
     'created_by_user_id',p_row->'created_by_user_id','created_at',p_row->'created_at',
     'reversal_of_movement_id',p_row->'reversal_of_movement_id',
     'corrects_movement_id',p_row->'corrects_movement_id',
     'correction_reason',p_row->'correction_reason',
     'corrected_by_movement_id',(select c.id from public.inventory_stock_movements c
       where c.tenant_id=nullif(p_row->>'tenant_id','')::bigint
         and c.site_id=nullif(p_row->>'site_id','')::bigint
         and c.reversal_of_movement_id=nullif(p_row->>'id','')::bigint
       order by c.id desc limit 1)
   )
   from public.inventory_items i
   join public.inventory_warehouses w
     on w.tenant_id=i.tenant_id
    and w.id=nullif(p_row->>'warehouse_id','')::bigint
    and w.site_id=nullif(p_row->>'site_id','')::bigint
   where i.tenant_id=nullif(p_row->>'tenant_id','')::bigint
     and i.id=nullif(p_row->>'item_id','')::bigint
 )
 when 'inventory_stocktakes' then public.powerhub_delta_sync_project_stocktake_row(p_row)
 else null end
$;
alter function public.powerhub_delta_sync_project_inventory_row(text,jsonb) owner to postgres;
revoke all on function public.powerhub_delta_sync_project_inventory_row(text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_delta_sync_project_inventory_row(text,jsonb) to service_role;

create or replace function public.powerhub_append_inventory_sync_change(p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_entity_id text,p_change_type text,p_row_data jsonb)
returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_cursor bigint; v_cutoff bigint;
begin
 if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
 or p_entity_type not in ('inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements','inventory_stocktakes')
 or p_entity_id is null or length(p_entity_id) not between 1 and 100
 or p_change_type not in ('upsert','delete')
 or (p_change_type='upsert' and p_row_data is null) or (p_change_type='delete' and p_row_data is not null)
 or not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id)
 then raise exception 'POWERHUB_INVENTORY_DELTA_CHANGE_INVALID' using errcode='P0001'; end if;
 insert into public.powerhub_sync_scope_state(tenant_id,site_id,entity_type,last_cursor,retained_from_cursor,updated_at)
 values(p_tenant_id,p_site_id,p_entity_type,1,0,clock_timestamp())
 on conflict(tenant_id,site_id,entity_type) do update
 set last_cursor=public.powerhub_sync_scope_state.last_cursor+1,updated_at=clock_timestamp()
 returning last_cursor into v_cursor;
 insert into public.powerhub_sync_changes(tenant_id,site_id,entity_type,cursor,entity_id,change_type,row_data,changed_at)
 values(p_tenant_id,p_site_id,p_entity_type,v_cursor,p_entity_id,p_change_type,p_row_data,clock_timestamp());
 if v_cursor>10000 and mod(v_cursor,500)=0 then
   v_cutoff:=v_cursor-10000;
   delete from public.powerhub_sync_changes c where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type and c.cursor<=v_cutoff;
   update public.powerhub_sync_scope_state s set retained_from_cursor=greatest(s.retained_from_cursor,v_cutoff),updated_at=clock_timestamp()
   where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
 end if;
 return v_cursor;
end $$;
alter function public.powerhub_append_inventory_sync_change(bigint,bigint,text,text,text,jsonb) owner to postgres;
revoke all on function public.powerhub_append_inventory_sync_change(bigint,bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_append_inventory_sync_change(bigint,bigint,text,text,text,jsonb) to service_role;

create or replace function public.powerhub_get_inventory_sync_snapshot(p_tenant_id bigint,p_site_id bigint,p_entity_type text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_cursor bigint:=0; v_retained bigint:=0; v_rows jsonb:='[]'::jsonb;
begin
 if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001'; end if;
 if p_entity_type not in ('inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements','inventory_stocktakes') then raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001'; end if;
 if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select s.last_cursor,s.retained_from_cursor into v_cursor,v_retained from public.powerhub_sync_scope_state s where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
 if not found then v_cursor:=0; v_retained:=0; end if;
 case p_entity_type
 when 'inventory_items' then
  select coalesce(jsonb_agg(public.powerhub_delta_sync_project_inventory_row('inventory_items',to_jsonb(i)) order by lower(i.name),i.id),'[]'::jsonb) into v_rows
  from public.inventory_items i where i.tenant_id=p_tenant_id and i.is_active=true;
 when 'inventory_item_units' then
  select coalesce(jsonb_agg(public.powerhub_delta_sync_project_inventory_row('inventory_item_units',to_jsonb(u)) order by u.item_id,lower(u.unit_label),u.id),'[]'::jsonb) into v_rows
  from public.inventory_item_units u where u.tenant_id=p_tenant_id and u.is_active=true;
 when 'suppliers' then
  select coalesce(jsonb_agg(public.powerhub_delta_sync_project_inventory_row('suppliers',to_jsonb(s)) order by lower(s.name),s.id),'[]'::jsonb) into v_rows
  from public.suppliers s where s.tenant_id=p_tenant_id and s.is_active=true;
 when 'inventory_warehouses' then
  select coalesce(jsonb_agg(public.powerhub_delta_sync_project_inventory_row('inventory_warehouses',to_jsonb(w)) order by lower(w.name),w.id),'[]'::jsonb) into v_rows
  from public.inventory_warehouses w where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.is_active=true;
 when 'inventory_stock_movements' then
  select coalesce(jsonb_agg(public.powerhub_delta_sync_project_inventory_row('inventory_stock_movements',to_jsonb(m))
    order by m.occurred_at desc,m.id desc),'[]'::jsonb) into v_rows
  from (
    select movement.* from public.inventory_stock_movements movement
    where movement.tenant_id=p_tenant_id and movement.site_id=p_site_id
    order by movement.occurred_at desc,movement.id desc limit 500
  ) m;
 when 'inventory_stocktakes' then
   select coalesce(jsonb_agg(public.powerhub_delta_sync_project_stocktake_row(to_jsonb(st))
     order by st.created_at desc,st.id desc),'[]'::jsonb) into v_rows
   from (
     select stocktake.* from public.inventory_stocktakes stocktake
     where stocktake.tenant_id=p_tenant_id and stocktake.site_id=p_site_id
     order by stocktake.created_at desc,stocktake.id desc limit 200
   ) st;
  end case;
 return jsonb_build_object('status','ok','entity_type',p_entity_type,'snapshot_cursor',v_cursor::text,'retained_from_cursor',v_retained::text,'rows',v_rows);
end $$;
alter function public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text) owner to postgres;
revoke all on function public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text) to service_role;

create or replace function public.powerhub_pull_inventory_sync_delta(p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_after_cursor bigint,p_through_cursor bigint default null,p_page_size integer default 200)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_current bigint:=0; v_retained bigint:=0; v_target bigint:=0; v_next bigint:=0; v_last bigint; v_more boolean:=false; v_changes jsonb:='[]'::jsonb;
begin
 if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 then raise exception 'POWERHUB_SYNC_SCOPE_REQUIRED' using errcode='P0001'; end if;
 if p_entity_type not in ('inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements','inventory_stocktakes') then raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001'; end if;
 if p_page_size is null or p_page_size<1 or p_page_size>500 then raise exception 'POWERHUB_SYNC_PAGE_SIZE_INVALID' using errcode='P0001'; end if;
 if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id) then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select s.last_cursor,s.retained_from_cursor into v_current,v_retained from public.powerhub_sync_scope_state s where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.entity_type=p_entity_type;
 if not found then v_current:=0; v_retained:=0; end if;
 if p_after_cursor is null or p_after_cursor<v_retained then
   return jsonb_build_object('status','reset_required','entity_type',p_entity_type,'current_cursor',v_current::text,'retained_from_cursor',v_retained::text,'snapshot_cursor',v_current::text,'through_cursor',v_current::text,'next_cursor',null,'has_more',false,'changes','[]'::jsonb);
 end if;
 if p_after_cursor<0 or p_after_cursor>v_current then raise exception 'POWERHUB_SYNC_CURSOR_INVALID' using errcode='P0001'; end if;
 if p_through_cursor is null then v_target:=v_current;
 else v_target:=p_through_cursor; if v_target<p_after_cursor or v_target>v_current then raise exception 'POWERHUB_SYNC_TARGET_CURSOR_INVALID' using errcode='P0001'; end if; end if;
 with page_rows as (
  select c.cursor,c.entity_type,c.entity_id,c.change_type,c.row_data,c.changed_at from public.powerhub_sync_changes c
  where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type and c.cursor>p_after_cursor and c.cursor<=v_target
  order by c.cursor limit p_page_size
 )
 select coalesce(jsonb_agg(jsonb_build_object('cursor',p.cursor::text,'entity_type',p.entity_type,'entity_id',p.entity_id,'operation',p.change_type,'row_data',p.row_data,'changed_at',p.changed_at) order by p.cursor),'[]'::jsonb),max(p.cursor)
 into v_changes,v_last from page_rows p;
 select exists(select 1 from public.powerhub_sync_changes c where c.tenant_id=p_tenant_id and c.site_id=p_site_id and c.entity_type=p_entity_type and c.cursor>coalesce(v_last,p_after_cursor) and c.cursor<=v_target) into v_more;
 if v_more then v_next:=coalesce(v_last,p_after_cursor); else v_next:=v_target; end if;
 return jsonb_build_object('status','ok','entity_type',p_entity_type,'current_cursor',v_current::text,'retained_from_cursor',v_retained::text,'snapshot_cursor',null,'through_cursor',v_target::text,'next_cursor',v_next::text,'has_more',v_more,'changes',v_changes);
end $$;
alter function public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer) owner to postgres;
revoke all on function public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer) to service_role;

create or replace function public.powerhub_emit_inventory_stocktake_sync_change(p_tenant_id bigint,p_stocktake_id bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_site_id bigint; v_source jsonb; v_row jsonb;
begin
  select st.site_id,to_jsonb(st) into v_site_id,v_source
  from public.inventory_stocktakes st where st.tenant_id=p_tenant_id and st.id=p_stocktake_id;
  if not found then return; end if;
  v_row:=public.powerhub_delta_sync_project_stocktake_row(v_source);
  if v_row is null then raise exception 'POWERHUB_STOCKTAKE_DELTA_PROJECTION_FAILED' using errcode='P0001'; end if;
  perform public.powerhub_append_inventory_sync_change(
    p_tenant_id,v_site_id,'inventory_stocktakes',p_stocktake_id::text,'upsert',v_row
  );
end $$;
alter function public.powerhub_emit_inventory_stocktake_sync_change(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_emit_inventory_stocktake_sync_change(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_emit_inventory_stocktake_sync_change(bigint,bigint) to service_role;

create or replace function public.powerhub_capture_inventory_stocktake_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_old_tenant bigint; v_old_site bigint; v_new_tenant bigint; v_new_site bigint;
begin
  if TG_OP<>'INSERT' then v_old_tenant:=OLD.tenant_id; v_old_site:=OLD.site_id; end if;
  if TG_OP<>'DELETE' then v_new_tenant:=NEW.tenant_id; v_new_site:=NEW.site_id; end if;
  if TG_OP='UPDATE' and to_jsonb(OLD) is not distinct from to_jsonb(NEW) then return NEW; end if;
  if TG_OP<>'INSERT' and
     (TG_OP='DELETE' or v_old_tenant is distinct from v_new_tenant or v_old_site is distinct from v_new_site) then
    perform public.powerhub_append_inventory_sync_change(v_old_tenant,v_old_site,'inventory_stocktakes',OLD.id::text,'delete',null);
  end if;
  if TG_OP<>'DELETE' then perform public.powerhub_emit_inventory_stocktake_sync_change(v_new_tenant,NEW.id); end if;
  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;
alter function public.powerhub_capture_inventory_stocktake_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_inventory_stocktake_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_inventory_stocktake_delta_sync_change() to service_role;

create or replace function public.powerhub_capture_inventory_stocktake_line_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='DELETE' then
    perform public.powerhub_emit_inventory_stocktake_sync_change(OLD.tenant_id,OLD.stocktake_id);
    return OLD;
  end if;
  if TG_OP='UPDATE' and (OLD.tenant_id is distinct from NEW.tenant_id or OLD.stocktake_id is distinct from NEW.stocktake_id) then
    perform public.powerhub_emit_inventory_stocktake_sync_change(OLD.tenant_id,OLD.stocktake_id);
  end if;
  perform public.powerhub_emit_inventory_stocktake_sync_change(NEW.tenant_id,NEW.stocktake_id);
  return NEW;
end $$;
alter function public.powerhub_capture_inventory_stocktake_line_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_inventory_stocktake_line_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_inventory_stocktake_line_delta_sync_change() to service_role;

create or replace function public.powerhub_refresh_stocktake_delta_after_warehouse_update()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_stocktake record;
begin
  for v_stocktake in
    select st.tenant_id,st.id from public.inventory_stocktakes st
    where st.tenant_id=NEW.tenant_id and st.site_id=NEW.site_id and st.warehouse_id=NEW.id
    order by st.id
  loop
    perform public.powerhub_emit_inventory_stocktake_sync_change(v_stocktake.tenant_id,v_stocktake.id);
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_stocktake_delta_after_warehouse_update() owner to postgres;
revoke all on function public.powerhub_refresh_stocktake_delta_after_warehouse_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_stocktake_delta_after_warehouse_update() to service_role;

drop trigger if exists powerhub_delta_sync_inventory_stocktakes on public.inventory_stocktakes;
create trigger powerhub_delta_sync_inventory_stocktakes after insert or update or delete on public.inventory_stocktakes
for each row execute function public.powerhub_capture_inventory_stocktake_delta_sync_change();
drop trigger if exists powerhub_delta_sync_inventory_stocktake_lines on public.inventory_stocktake_lines;
create trigger powerhub_delta_sync_inventory_stocktake_lines after insert or update or delete on public.inventory_stocktake_lines
for each row execute function public.powerhub_capture_inventory_stocktake_line_delta_sync_change();
drop trigger if exists powerhub_delta_sync_stocktakes_from_warehouse on public.inventory_warehouses;
create trigger powerhub_delta_sync_stocktakes_from_warehouse after update of name,location_type on public.inventory_warehouses
for each row execute function public.powerhub_refresh_stocktake_delta_after_warehouse_update();

select pg_notify('pgrst','reload schema');
