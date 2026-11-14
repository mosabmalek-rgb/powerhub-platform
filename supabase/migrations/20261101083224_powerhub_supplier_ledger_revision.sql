-- Supplier ledger revision-only feed: opaque cursor metadata, no row-level Delta feed.
alter table public.powerhub_sync_scope_state
  drop constraint if exists powerhub_sync_scope_state_entity_type_check;
alter table public.powerhub_sync_scope_state
  add constraint powerhub_sync_scope_state_entity_type_check
  check (entity_type in (
    'sites','subscribers','generators','readings','tariffs','invoices','payments','expenses',
    'company_accounts','company_accounts_all','inventory_items','inventory_item_units','suppliers',
    'inventory_warehouses','inventory_stock_movements','inventory_stocktakes','inventory_purchase_headers',
    'inventory_purchase_receipt_headers','inventory_supplier_return_headers','fuel_readings',
    'maintenance_preventive_plans','fuel_events','maintenance_work_orders','hr_employee_directory',
    'hr_attendance','supplier_ledger'
  ) or entity_type ~ '^maintenance_work_order_parts:[1-9][0-9]{0,15}$');

create or replace function public.powerhub_bump_supplier_ledger_revision(p_tenant_id bigint,p_site_id bigint,p_supplier_id bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1 or p_supplier_id is null or p_supplier_id<1
    or not exists(select 1 from public.sites where tenant_id=p_tenant_id and id=p_site_id)
    or not exists(select 1 from public.suppliers where tenant_id=p_tenant_id and id=p_supplier_id)
  then raise exception 'SUPPLIER_LEDGER_REVISION_SCOPE_INVALID' using errcode='P0001'; end if;
  insert into public.powerhub_sync_scope_state(tenant_id,site_id,entity_type,last_cursor,retained_from_cursor,updated_at)
  values(p_tenant_id,p_site_id,'supplier_ledger',1,0,clock_timestamp())
  on conflict(tenant_id,site_id,entity_type) do update
    set last_cursor=public.powerhub_sync_scope_state.last_cursor+1,updated_at=clock_timestamp();
end $$;
alter function public.powerhub_bump_supplier_ledger_revision(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_bump_supplier_ledger_revision(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_bump_supplier_ledger_revision(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_bump_supplier_ledger_revision_for_purchase(p_tenant_id bigint,p_purchase_id bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v record;
begin
  select tenant_id,site_id,supplier_id,status into v from public.supplier_purchases
  where tenant_id=p_tenant_id and id=p_purchase_id;
  if found and v.status in ('confirmed','partially_received','received') then
    perform public.powerhub_bump_supplier_ledger_revision(v.tenant_id,v.site_id,v.supplier_id);
  end if;
end $$;
alter function public.powerhub_bump_supplier_ledger_revision_for_purchase(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_bump_supplier_ledger_revision_for_purchase(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_bump_supplier_ledger_revision_for_purchase(bigint,bigint) to service_role;

create or replace function public.powerhub_bump_supplier_ledger_revision_for_allocation(p_tenant_id bigint,p_purchase_id bigint,p_entry_id bigint)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v record;
begin
  if p_purchase_id is not null then
    select tenant_id,site_id,supplier_id into v from public.supplier_purchases where tenant_id=p_tenant_id and id=p_purchase_id;
  elsif p_entry_id is not null then
    select tenant_id,site_id,supplier_id into v from public.supplier_ledger_entries where tenant_id=p_tenant_id and id=p_entry_id;
  else raise exception 'SUPPLIER_LEDGER_ALLOCATION_TARGET_REQUIRED' using errcode='P0001';
  end if;
  if found then perform public.powerhub_bump_supplier_ledger_revision(v.tenant_id,v.site_id,v.supplier_id); end if;
end $$;
alter function public.powerhub_bump_supplier_ledger_revision_for_allocation(bigint,bigint,bigint) owner to postgres;
revoke all on function public.powerhub_bump_supplier_ledger_revision_for_allocation(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_bump_supplier_ledger_revision_for_allocation(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_capture_supplier_ledger_entry_revision()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then perform public.powerhub_bump_supplier_ledger_revision(NEW.tenant_id,NEW.site_id,NEW.supplier_id); return NEW;
  elsif TG_OP='DELETE' then perform public.powerhub_bump_supplier_ledger_revision(OLD.tenant_id,OLD.site_id,OLD.supplier_id); return OLD; end if;
  perform public.powerhub_bump_supplier_ledger_revision(OLD.tenant_id,OLD.site_id,OLD.supplier_id);
  if OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id or OLD.supplier_id is distinct from NEW.supplier_id
  then perform public.powerhub_bump_supplier_ledger_revision(NEW.tenant_id,NEW.site_id,NEW.supplier_id); end if;
  return NEW;
end $$;
alter function public.powerhub_capture_supplier_ledger_entry_revision() owner to postgres;
revoke all on function public.powerhub_capture_supplier_ledger_entry_revision() from public,anon,authenticated;
grant execute on function public.powerhub_capture_supplier_ledger_entry_revision() to service_role;

create or replace function public.powerhub_capture_supplier_purchase_revision()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare old_visible boolean:=false; new_visible boolean:=false; scope_changed boolean:=false;
begin
  if TG_OP<>'INSERT' then old_visible:=OLD.status in ('confirmed','partially_received','received'); end if;
  if TG_OP<>'DELETE' then new_visible:=NEW.status in ('confirmed','partially_received','received'); end if;
  if TG_OP='UPDATE' then scope_changed:=OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id or OLD.supplier_id is distinct from NEW.supplier_id; end if;
  if old_visible and (TG_OP='DELETE' or not new_visible or scope_changed) then
    perform public.powerhub_bump_supplier_ledger_revision(OLD.tenant_id,OLD.site_id,OLD.supplier_id);
  elsif TG_OP='UPDATE' and old_visible and new_visible and not scope_changed and to_jsonb(OLD) is distinct from to_jsonb(NEW) then
    perform public.powerhub_bump_supplier_ledger_revision(NEW.tenant_id,NEW.site_id,NEW.supplier_id); return NEW;
  end if;
  if new_visible and (TG_OP='INSERT' or not old_visible or scope_changed) then
    perform public.powerhub_bump_supplier_ledger_revision(NEW.tenant_id,NEW.site_id,NEW.supplier_id);
  end if;
  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;
alter function public.powerhub_capture_supplier_purchase_revision() owner to postgres;
revoke all on function public.powerhub_capture_supplier_purchase_revision() from public,anon,authenticated;
grant execute on function public.powerhub_capture_supplier_purchase_revision() to service_role;

create or replace function public.powerhub_capture_supplier_purchase_line_revision()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then perform public.powerhub_bump_supplier_ledger_revision_for_purchase(NEW.tenant_id,NEW.purchase_id); return NEW;
  elsif TG_OP='DELETE' then perform public.powerhub_bump_supplier_ledger_revision_for_purchase(OLD.tenant_id,OLD.purchase_id); return OLD; end if;
  perform public.powerhub_bump_supplier_ledger_revision_for_purchase(OLD.tenant_id,OLD.purchase_id);
  if OLD.tenant_id is distinct from NEW.tenant_id or OLD.purchase_id is distinct from NEW.purchase_id
    then perform public.powerhub_bump_supplier_ledger_revision_for_purchase(NEW.tenant_id,NEW.purchase_id); end if;
  return NEW;
end $$;
alter function public.powerhub_capture_supplier_purchase_line_revision() owner to postgres;
revoke all on function public.powerhub_capture_supplier_purchase_line_revision() from public,anon,authenticated;
grant execute on function public.powerhub_capture_supplier_purchase_line_revision() to service_role;

create or replace function public.powerhub_capture_supplier_payment_revision()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then perform public.powerhub_bump_supplier_ledger_revision(NEW.tenant_id,NEW.site_id,NEW.supplier_id); return NEW;
  elsif TG_OP='DELETE' then perform public.powerhub_bump_supplier_ledger_revision(OLD.tenant_id,OLD.site_id,OLD.supplier_id); return OLD; end if;
  perform public.powerhub_bump_supplier_ledger_revision(OLD.tenant_id,OLD.site_id,OLD.supplier_id);
  if OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id or OLD.supplier_id is distinct from NEW.supplier_id
    then perform public.powerhub_bump_supplier_ledger_revision(NEW.tenant_id,NEW.site_id,NEW.supplier_id); end if;
  return NEW;
end $$;
alter function public.powerhub_capture_supplier_payment_revision() owner to postgres;
revoke all on function public.powerhub_capture_supplier_payment_revision() from public,anon,authenticated;
grant execute on function public.powerhub_capture_supplier_payment_revision() to service_role;

create or replace function public.powerhub_capture_supplier_payment_allocation_revision()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then perform public.powerhub_bump_supplier_ledger_revision_for_allocation(NEW.tenant_id,NEW.purchase_id,NEW.supplier_ledger_entry_id); return NEW;
  elsif TG_OP='DELETE' then perform public.powerhub_bump_supplier_ledger_revision_for_allocation(OLD.tenant_id,OLD.purchase_id,OLD.supplier_ledger_entry_id); return OLD; end if;
  perform public.powerhub_bump_supplier_ledger_revision_for_allocation(OLD.tenant_id,OLD.purchase_id,OLD.supplier_ledger_entry_id);
  if OLD.tenant_id is distinct from NEW.tenant_id or OLD.purchase_id is distinct from NEW.purchase_id or OLD.supplier_ledger_entry_id is distinct from NEW.supplier_ledger_entry_id
    then perform public.powerhub_bump_supplier_ledger_revision_for_allocation(NEW.tenant_id,NEW.purchase_id,NEW.supplier_ledger_entry_id); end if;
  return NEW;
end $$;
alter function public.powerhub_capture_supplier_payment_allocation_revision() owner to postgres;
revoke all on function public.powerhub_capture_supplier_payment_allocation_revision() from public,anon,authenticated;
grant execute on function public.powerhub_capture_supplier_payment_allocation_revision() to service_role;

create or replace function public.powerhub_capture_supplier_return_revision()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='INSERT' then perform public.powerhub_bump_supplier_ledger_revision(NEW.tenant_id,NEW.site_id,NEW.supplier_id); return NEW;
  elsif TG_OP='DELETE' then perform public.powerhub_bump_supplier_ledger_revision(OLD.tenant_id,OLD.site_id,OLD.supplier_id); return OLD; end if;
  perform public.powerhub_bump_supplier_ledger_revision(OLD.tenant_id,OLD.site_id,OLD.supplier_id);
  if OLD.tenant_id is distinct from NEW.tenant_id or OLD.site_id is distinct from NEW.site_id or OLD.supplier_id is distinct from NEW.supplier_id
    then perform public.powerhub_bump_supplier_ledger_revision(NEW.tenant_id,NEW.site_id,NEW.supplier_id); end if;
  return NEW;
end $$;
alter function public.powerhub_capture_supplier_return_revision() owner to postgres;
revoke all on function public.powerhub_capture_supplier_return_revision() from public,anon,authenticated;
grant execute on function public.powerhub_capture_supplier_return_revision() to service_role;

create or replace function public.powerhub_capture_supplier_return_line_revision()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v_return record;
begin
  if TG_OP<>'INSERT' then
    select tenant_id,site_id,supplier_id into v_return from public.supplier_purchase_returns
      where tenant_id=OLD.tenant_id and id=OLD.return_id;
    if found then perform public.powerhub_bump_supplier_ledger_revision(v_return.tenant_id,v_return.site_id,v_return.supplier_id); end if;
  end if;
  if TG_OP='UPDATE' and (OLD.tenant_id is distinct from NEW.tenant_id or OLD.return_id is distinct from NEW.return_id) then
    select tenant_id,site_id,supplier_id into v_return from public.supplier_purchase_returns
      where tenant_id=NEW.tenant_id and id=NEW.return_id;
    if found then perform public.powerhub_bump_supplier_ledger_revision(v_return.tenant_id,v_return.site_id,v_return.supplier_id); end if;
  elsif TG_OP='INSERT' then
    select tenant_id,site_id,supplier_id into v_return from public.supplier_purchase_returns
      where tenant_id=NEW.tenant_id and id=NEW.return_id;
    if found then perform public.powerhub_bump_supplier_ledger_revision(v_return.tenant_id,v_return.site_id,v_return.supplier_id); end if;
  end if;
  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;
alter function public.powerhub_capture_supplier_return_line_revision() owner to postgres;
revoke all on function public.powerhub_capture_supplier_return_line_revision() from public,anon,authenticated;
grant execute on function public.powerhub_capture_supplier_return_line_revision() to service_role;

create or replace function public.powerhub_refresh_supplier_ledger_revision_after_supplier_update()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare v record;
begin
  for v in
    select distinct e.site_id from public.supplier_ledger_entries e where e.tenant_id=NEW.tenant_id and e.supplier_id=NEW.id
    union select distinct p.site_id from public.supplier_purchases p
      where p.tenant_id=NEW.tenant_id and p.supplier_id=NEW.id and p.status in ('confirmed','partially_received','received')
    order by 1
  loop perform public.powerhub_bump_supplier_ledger_revision(NEW.tenant_id,v.site_id,NEW.id); end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_supplier_ledger_revision_after_supplier_update() owner to postgres;
revoke all on function public.powerhub_refresh_supplier_ledger_revision_after_supplier_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_supplier_ledger_revision_after_supplier_update() to service_role;

drop trigger if exists powerhub_supplier_ledger_revision_entries on public.supplier_ledger_entries;
create trigger powerhub_supplier_ledger_revision_entries after insert or update or delete on public.supplier_ledger_entries
for each row execute function public.powerhub_capture_supplier_ledger_entry_revision();
drop trigger if exists powerhub_supplier_ledger_revision_purchases on public.supplier_purchases;
create trigger powerhub_supplier_ledger_revision_purchases after insert or update or delete on public.supplier_purchases
for each row execute function public.powerhub_capture_supplier_purchase_revision();
drop trigger if exists powerhub_supplier_ledger_revision_purchase_lines on public.supplier_purchase_lines;
create trigger powerhub_supplier_ledger_revision_purchase_lines after insert or update or delete on public.supplier_purchase_lines
for each row execute function public.powerhub_capture_supplier_purchase_line_revision();
drop trigger if exists powerhub_supplier_ledger_revision_payments on public.supplier_payments;
create trigger powerhub_supplier_ledger_revision_payments after insert or update or delete on public.supplier_payments
for each row execute function public.powerhub_capture_supplier_payment_revision();
drop trigger if exists powerhub_supplier_ledger_revision_allocations on public.supplier_payment_allocations;
create trigger powerhub_supplier_ledger_revision_allocations after insert or update or delete on public.supplier_payment_allocations
for each row execute function public.powerhub_capture_supplier_payment_allocation_revision();
drop trigger if exists powerhub_supplier_ledger_revision_returns on public.supplier_purchase_returns;
create trigger powerhub_supplier_ledger_revision_returns after insert or update or delete on public.supplier_purchase_returns
for each row execute function public.powerhub_capture_supplier_return_revision();
drop trigger if exists powerhub_supplier_ledger_revision_return_lines on public.supplier_purchase_return_lines;
create trigger powerhub_supplier_ledger_revision_return_lines after insert or update or delete on public.supplier_purchase_return_lines
for each row execute function public.powerhub_capture_supplier_return_line_revision();
drop trigger if exists powerhub_supplier_ledger_revision_supplier_name on public.suppliers;
create trigger powerhub_supplier_ledger_revision_supplier_name after update of name,supplier_code on public.suppliers
for each row execute function public.powerhub_refresh_supplier_ledger_revision_after_supplier_update();

select pg_notify('pgrst','reload schema');
