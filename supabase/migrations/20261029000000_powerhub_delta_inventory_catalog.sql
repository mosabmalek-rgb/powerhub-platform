-- Read-only Delta feeds for inventory catalogs and the non-financial stock-movement list.
-- Catalog rows are tenant-scoped; warehouses and stock movements are site-scoped.
-- Financial movement cost fields are deliberately excluded from the local Delta projection.
alter table public.powerhub_sync_scope_state drop constraint if exists powerhub_sync_scope_state_entity_type_check;
alter table public.powerhub_sync_scope_state add constraint powerhub_sync_scope_state_entity_type_check
  check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices','payments','expenses','company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements'));
alter table public.powerhub_sync_changes drop constraint if exists powerhub_sync_changes_entity_type_check;
alter table public.powerhub_sync_changes add constraint powerhub_sync_changes_entity_type_check
  check (entity_type in ('sites','subscribers','generators','readings','tariffs','invoices','payments','expenses','company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers','inventory_warehouses'));

create or replace function public.powerhub_delta_sync_project_inventory_row(p_entity_type text,p_row jsonb)
returns jsonb language sql stable set search_path=pg_catalog,public,pg_temp as $
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
     'corrected_by_movement_id',p_row->'corrected_by_movement_id'
   )
   from public.inventory_items i
   join public.inventory_warehouses w
     on w.tenant_id=i.tenant_id
    and w.id=nullif(p_row->>'warehouse_id','')::bigint
    and w.site_id=nullif(p_row->>'site_id','')::bigint
   where i.tenant_id=nullif(p_row->>'tenant_id','')::bigint
     and i.id=nullif(p_row->>'item_id','')::bigint
 )
 else null end
$$;
alter function public.powerhub_delta_sync_project_inventory_row(text,jsonb) owner to postgres;
revoke all on function public.powerhub_delta_sync_project_inventory_row(text,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_delta_sync_project_inventory_row(text,jsonb) to service_role;

create or replace function public.powerhub_append_inventory_sync_change(p_tenant_id bigint,p_site_id bigint,p_entity_type text,p_entity_id text,p_change_type text,p_row_data jsonb)
returns bigint language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_cursor bigint; v_cutoff bigint;
begin
 if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
 or p_entity_type not in ('inventory_items','inventory_item_units','suppliers','inventory_warehouses','inventory_stock_movements')
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
 if p_entity_type not in ('inventory_items','inventory_item_units','suppliers','inventory_warehouses') then raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001'; end if;
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
 if p_entity_type not in ('inventory_items','inventory_item_units','suppliers','inventory_warehouses') then raise exception 'POWERHUB_SYNC_ENTITY_UNSUPPORTED' using errcode='P0001'; end if;
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

create or replace function public.powerhub_capture_inventory_delta_sync_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare
 v_entity text; v_old jsonb; v_new jsonb; v_old_tenant bigint; v_new_tenant bigint; v_old_site bigint; v_new_site bigint;
 v_old_visible boolean:=false; v_new_visible boolean:=false; v_site bigint; v_row jsonb; v_shared boolean;
begin
 v_entity:=case TG_TABLE_NAME when 'inventory_items' then 'inventory_items' when 'inventory_item_units' then 'inventory_item_units' when 'suppliers' then 'suppliers' when 'inventory_warehouses' then 'inventory_warehouses' when 'inventory_stock_movements' then 'inventory_stock_movements' else null end;
 if v_entity is null then raise exception 'POWERHUB_INVENTORY_DELTA_TABLE_UNSUPPORTED' using errcode='P0001'; end if;
 if TG_OP<>'INSERT' then v_old:=to_jsonb(OLD); end if;
 if TG_OP<>'DELETE' then v_new:=to_jsonb(NEW); end if;
 if TG_OP='UPDATE' and v_old is not distinct from v_new then return NEW; end if;
 if v_old is not null then
  v_old_tenant:=nullif(v_old->>'tenant_id','')::bigint;
  v_old_visible:=case when v_entity='inventory_stock_movements' then true else coalesce((v_old->>'is_active')::boolean,false) end;
  if v_entity in ('inventory_warehouses','inventory_stock_movements') then v_old_site:=nullif(v_old->>'site_id','')::bigint; end if;
 end if;
 if v_new is not null then
  v_new_tenant:=nullif(v_new->>'tenant_id','')::bigint;
  v_new_visible:=case when v_entity='inventory_stock_movements' then true else coalesce((v_new->>'is_active')::boolean,false) end;
  if v_entity in ('inventory_warehouses','inventory_stock_movements') then v_new_site:=nullif(v_new->>'site_id','')::bigint; end if;
 end if;
 v_shared:=v_entity in ('inventory_items','inventory_item_units','suppliers');
 if v_shared then
  if v_old is not null and (TG_OP='DELETE' or v_old_tenant is distinct from v_new_tenant or (v_old_visible and not v_new_visible)) then
   for v_site in select s.id from public.sites s where s.tenant_id=v_old_tenant order by s.id loop
    perform public.powerhub_append_inventory_sync_change(v_old_tenant,v_site,v_entity,v_old->>'id','delete',null);
   end loop;
  end if;
  if v_new is not null and v_new_visible then
   v_row:=public.powerhub_delta_sync_project_inventory_row(v_entity,v_new);
   for v_site in select s.id from public.sites s where s.tenant_id=v_new_tenant order by s.id loop
    perform public.powerhub_append_inventory_sync_change(v_new_tenant,v_site,v_entity,v_new->>'id','upsert',v_row);
   end loop;
  end if;
 else
  if v_old is not null and v_old_visible and (TG_OP='DELETE' or v_old_tenant is distinct from v_new_tenant or v_old_site is distinct from v_new_site or not v_new_visible) then
   perform public.powerhub_append_inventory_sync_change(v_old_tenant,v_old_site,v_entity,v_old->>'id','delete',null);
  end if;
  if v_new is not null and v_new_visible then
   v_row:=public.powerhub_delta_sync_project_inventory_row(v_entity,v_new);
   perform public.powerhub_append_inventory_sync_change(v_new_tenant,v_new_site,v_entity,v_new->>'id','upsert',v_row);
  end if;
 end if;
 if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;
alter function public.powerhub_capture_inventory_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_inventory_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_inventory_delta_sync_change() to service_role;

drop trigger if exists powerhub_delta_sync_inventory_items on public.inventory_items;
create trigger powerhub_delta_sync_inventory_items after insert or update or delete on public.inventory_items for each row execute function public.powerhub_capture_inventory_delta_sync_change();
drop trigger if exists powerhub_delta_sync_inventory_item_units on public.inventory_item_units;
create trigger powerhub_delta_sync_inventory_item_units after insert or update or delete on public.inventory_item_units for each row execute function public.powerhub_capture_inventory_delta_sync_change();
drop trigger if exists powerhub_delta_sync_suppliers on public.suppliers;
create trigger powerhub_delta_sync_suppliers after insert or update or delete on public.suppliers for each row execute function public.powerhub_capture_inventory_delta_sync_change();
drop trigger if exists powerhub_delta_sync_inventory_warehouses on public.inventory_warehouses;
create trigger powerhub_delta_sync_inventory_warehouses after insert or update or delete on public.inventory_warehouses for each row execute function public.powerhub_capture_inventory_delta_sync_change();
drop trigger if exists powerhub_delta_sync_inventory_stock_movements on public.inventory_stock_movements;
create trigger powerhub_delta_sync_inventory_stock_movements after insert on public.inventory_stock_movements for each row execute function public.powerhub_capture_inventory_delta_sync_change();

revoke all on function public.powerhub_get_inventory_sync_snapshot(bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.powerhub_pull_inventory_sync_delta(bigint,bigint,text,bigint,bigint,integer) from public,anon,authenticated;
