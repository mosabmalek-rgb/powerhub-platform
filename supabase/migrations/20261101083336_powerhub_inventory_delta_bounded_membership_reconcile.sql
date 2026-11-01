-- Reconcile bounded inventory Delta feeds when a row leaves or changes its sort position.
-- The browser retains only the newest 200 headers per feed, so tombstones or changed
-- rows alone are insufficient: the server must also publish the replacement at rank 201.

create or replace function public.powerhub_refresh_inventory_purchase_header_delta_scope(
  p_tenant_id bigint,p_site_id bigint
)
returns void
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_purchase record;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
     or not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'POWERHUB_SYNC_SCOPE_INVALID' using errcode='P0001';
  end if;
  for v_purchase in
    select p.id
    from public.supplier_purchases p
    where p.tenant_id=p_tenant_id and p.site_id=p_site_id
      and p.status in ('confirmed','partially_received','received')
    order by p.invoice_date desc,p.id desc
    limit 200
  loop
    perform public.powerhub_emit_inventory_purchase_header_sync_change(p_tenant_id,v_purchase.id);
  end loop;
end $$;
alter function public.powerhub_refresh_inventory_purchase_header_delta_scope(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_inventory_purchase_header_delta_scope(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_inventory_purchase_header_delta_scope(bigint,bigint) to service_role;

create or replace function public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(
  p_tenant_id bigint,p_site_id bigint
)
returns void
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_receipt record;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
     or not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'POWERHUB_SYNC_SCOPE_INVALID' using errcode='P0001';
  end if;
  for v_receipt in
    select r.id
    from public.supplier_purchase_receipts r
    join public.supplier_purchases p
      on p.tenant_id=r.tenant_id and p.id=r.purchase_id and p.site_id=r.site_id
    where r.tenant_id=p_tenant_id and r.site_id=p_site_id
      and p.status in ('confirmed','partially_received','received')
    order by r.received_at desc,r.id desc
    limit 200
  loop
    perform public.powerhub_emit_inventory_purchase_receipt_header_sync_change(p_tenant_id,v_receipt.id);
  end loop;
end $$;
alter function public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(bigint,bigint) to service_role;

create or replace function public.powerhub_refresh_inventory_supplier_return_header_delta_scope(
  p_tenant_id bigint,p_site_id bigint
)
returns void
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_return record;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
     or not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'POWERHUB_SYNC_SCOPE_INVALID' using errcode='P0001';
  end if;
  for v_return in
    select r.id
    from public.supplier_purchase_returns r
    join public.supplier_purchases p
      on p.tenant_id=r.tenant_id and p.id=r.purchase_id and p.site_id=r.site_id
    where r.tenant_id=p_tenant_id and r.site_id=p_site_id
      and r.status='posted'
      and p.status in ('confirmed','partially_received','received')
    order by r.return_date desc,r.id desc
    limit 200
  loop
    perform public.powerhub_emit_inventory_supplier_return_header_sync_change(p_tenant_id,v_return.id);
  end loop;
end $$;
alter function public.powerhub_refresh_inventory_supplier_return_header_delta_scope(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_inventory_supplier_return_header_delta_scope(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_inventory_supplier_return_header_delta_scope(bigint,bigint) to service_role;

-- Purchase headers are ordered by invoice_date; tombstones and current top-200
-- upserts are emitted in one source transaction after deletion, visibility exit,
-- scope movement, or any update that changes rank.
create or replace function public.powerhub_capture_inventory_purchase_header_delta_sync_change()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare
  v_old_visible boolean:=false;
  v_new_visible boolean:=false;
  v_scope_changed boolean:=false;
  v_rank_changed boolean:=false;
begin
  if TG_OP<>'INSERT' then
    v_old_visible:=OLD.status in ('confirmed','partially_received','received');
  end if;
  if TG_OP<>'DELETE' then
    v_new_visible:=NEW.status in ('confirmed','partially_received','received');
  end if;
  if TG_OP='UPDATE' then
    v_scope_changed:=OLD.tenant_id is distinct from NEW.tenant_id
      or OLD.site_id is distinct from NEW.site_id;
    v_rank_changed:=OLD.invoice_date is distinct from NEW.invoice_date;
    if to_jsonb(OLD) is not distinct from to_jsonb(NEW) then return NEW; end if;
  end if;

  if v_old_visible and (TG_OP='DELETE' or not v_new_visible or v_scope_changed) then
    perform public.powerhub_append_inventory_sync_change(
      OLD.tenant_id,OLD.site_id,'inventory_purchase_headers',OLD.id::text,'delete',null
    );
    perform public.powerhub_refresh_inventory_purchase_header_delta_scope(OLD.tenant_id,OLD.site_id);
  end if;

  if v_new_visible then
    perform public.powerhub_emit_inventory_purchase_header_sync_change(NEW.tenant_id,NEW.id);
    if TG_OP='UPDATE' and (not v_old_visible or v_scope_changed or v_rank_changed) then
      perform public.powerhub_refresh_inventory_purchase_header_delta_scope(NEW.tenant_id,NEW.site_id);
    end if;
  end if;

  if TG_OP='DELETE' then return OLD; else return NEW; end if;
end $$;
alter function public.powerhub_capture_inventory_purchase_header_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_inventory_purchase_header_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_inventory_purchase_header_delta_sync_change() to service_role;

-- Receipt snapshots are ordered by received_at. Reconcile the old and new site
-- after a delete/move and refill after an existing receipt changes rank.
create or replace function public.powerhub_capture_purchase_receipt_header_delta_sync_change()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_scope_changed boolean:=false; v_rank_changed boolean:=false;
begin
  if TG_OP='DELETE' then
    perform public.powerhub_append_inventory_sync_change(
      OLD.tenant_id,OLD.site_id,'inventory_purchase_receipt_headers',OLD.id::text,'delete',null
    );
    perform public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(OLD.tenant_id,OLD.site_id);
    return OLD;
  end if;

  if TG_OP='UPDATE' then
    if to_jsonb(OLD) is not distinct from to_jsonb(NEW) then return NEW; end if;
    v_scope_changed:=OLD.tenant_id is distinct from NEW.tenant_id
      or OLD.site_id is distinct from NEW.site_id;
    v_rank_changed:=OLD.received_at is distinct from NEW.received_at;
    if v_scope_changed then
      perform public.powerhub_append_inventory_sync_change(
        OLD.tenant_id,OLD.site_id,'inventory_purchase_receipt_headers',OLD.id::text,'delete',null
      );
      perform public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(OLD.tenant_id,OLD.site_id);
    end if;
  end if;

  perform public.powerhub_emit_inventory_purchase_receipt_header_sync_change(NEW.tenant_id,NEW.id);
  if TG_OP='UPDATE' and (v_scope_changed or v_rank_changed) then
    perform public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(NEW.tenant_id,NEW.site_id);
  end if;
  return NEW;
end $$;
alter function public.powerhub_capture_purchase_receipt_header_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_purchase_receipt_header_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_purchase_receipt_header_delta_sync_change() to service_role;

-- Return snapshots are ordered by return_date and currently expose only posted
-- returns. Keep the visibility check explicit so a future lifecycle extension
-- cannot leave a formerly visible row cached after it exits the feed.
create or replace function public.powerhub_capture_supplier_return_header_delta_sync_change()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare
  v_old_visible boolean:=false;
  v_new_visible boolean:=false;
  v_scope_changed boolean:=false;
  v_rank_changed boolean:=false;
begin
  if TG_OP<>'INSERT' then v_old_visible:=OLD.status='posted'; end if;
  if TG_OP<>'DELETE' then v_new_visible:=NEW.status='posted'; end if;

  if TG_OP='DELETE' then
    if v_old_visible then
      perform public.powerhub_append_inventory_sync_change(
        OLD.tenant_id,OLD.site_id,'inventory_supplier_return_headers',OLD.id::text,'delete',null
      );
      perform public.powerhub_refresh_inventory_supplier_return_header_delta_scope(OLD.tenant_id,OLD.site_id);
    end if;
    return OLD;
  end if;

  if TG_OP='UPDATE' then
    if to_jsonb(OLD) is not distinct from to_jsonb(NEW) then return NEW; end if;
    v_scope_changed:=OLD.tenant_id is distinct from NEW.tenant_id
      or OLD.site_id is distinct from NEW.site_id;
    v_rank_changed:=OLD.return_date is distinct from NEW.return_date;
    if v_old_visible and (not v_new_visible or v_scope_changed) then
      perform public.powerhub_append_inventory_sync_change(
        OLD.tenant_id,OLD.site_id,'inventory_supplier_return_headers',OLD.id::text,'delete',null
      );
      perform public.powerhub_refresh_inventory_supplier_return_header_delta_scope(OLD.tenant_id,OLD.site_id);
    end if;
  end if;

  if v_new_visible then
    perform public.powerhub_emit_inventory_supplier_return_header_sync_change(NEW.tenant_id,NEW.id);
    if TG_OP='UPDATE' and (not v_old_visible or v_scope_changed or v_rank_changed) then
      perform public.powerhub_refresh_inventory_supplier_return_header_delta_scope(NEW.tenant_id,NEW.site_id);
    end if;
  end if;
  return NEW;
end $$;
alter function public.powerhub_capture_supplier_return_header_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_supplier_return_header_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_supplier_return_header_delta_sync_change() to service_role;

-- A purchase can change the eligibility or projections of every receipt and
-- return linked to it. Reconcile the affected bounded feed(s) instead of
-- appending unbounded child upserts and leaving stale membership behind.
create or replace function public.powerhub_capture_purchase_children_delta_after_parent_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare
  v_old_visible boolean;
  v_new_visible boolean;
  v_scope_changed boolean;
  v_child record;
begin
  v_old_visible:=OLD.status in ('confirmed','partially_received','received');
  v_new_visible:=NEW.status in ('confirmed','partially_received','received');
  v_scope_changed:=OLD.tenant_id is distinct from NEW.tenant_id
    or OLD.site_id is distinct from NEW.site_id;

  if v_old_visible and (not v_new_visible or v_scope_changed) then
    for v_child in
      select r.id,r.site_id from public.supplier_purchase_receipts r
      where r.tenant_id=OLD.tenant_id and r.purchase_id=OLD.id and r.site_id=OLD.site_id
      order by r.id
    loop
      perform public.powerhub_append_inventory_sync_change(
        OLD.tenant_id,v_child.site_id,'inventory_purchase_receipt_headers',v_child.id::text,'delete',null
      );
    end loop;
    for v_child in
      select r.id,r.site_id from public.supplier_purchase_returns r
      where r.tenant_id=OLD.tenant_id and r.purchase_id=OLD.id and r.site_id=OLD.site_id
      order by r.id
    loop
      perform public.powerhub_append_inventory_sync_change(
        OLD.tenant_id,v_child.site_id,'inventory_supplier_return_headers',v_child.id::text,'delete',null
      );
    end loop;
    perform public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(OLD.tenant_id,OLD.site_id);
    perform public.powerhub_refresh_inventory_supplier_return_header_delta_scope(OLD.tenant_id,OLD.site_id);
  end if;

  if v_new_visible then
    perform public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(NEW.tenant_id,NEW.site_id);
    perform public.powerhub_refresh_inventory_supplier_return_header_delta_scope(NEW.tenant_id,NEW.site_id);
  end if;
  return NEW;
end $$;
alter function public.powerhub_capture_purchase_children_delta_after_parent_update() owner to postgres;
revoke all on function public.powerhub_capture_purchase_children_delta_after_parent_update() from public,anon,authenticated;
grant execute on function public.powerhub_capture_purchase_children_delta_after_parent_update() to service_role;

-- Supplier and warehouse labels are denormalized into header projections. Rebuild
-- only the bounded per-site feeds, not every historical purchase/receipt/return.
create or replace function public.powerhub_refresh_purchase_headers_after_supplier_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_site record;
begin
  for v_site in
    select distinct p.site_id
    from public.supplier_purchases p
    where p.tenant_id=NEW.tenant_id and p.supplier_id=NEW.id
      and p.status in ('confirmed','partially_received','received')
    order by p.site_id
  loop
    perform public.powerhub_refresh_inventory_purchase_header_delta_scope(NEW.tenant_id,v_site.site_id);
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_purchase_headers_after_supplier_update() owner to postgres;
revoke all on function public.powerhub_refresh_purchase_headers_after_supplier_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_purchase_headers_after_supplier_update() to service_role;

create or replace function public.powerhub_refresh_purchase_child_headers_after_supplier_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_site record;
begin
  for v_site in
    select distinct p.site_id
    from public.supplier_purchases p
    where p.tenant_id=NEW.tenant_id and p.supplier_id=NEW.id
      and p.status in ('confirmed','partially_received','received')
    order by p.site_id
  loop
    perform public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(NEW.tenant_id,v_site.site_id);
    perform public.powerhub_refresh_inventory_supplier_return_header_delta_scope(NEW.tenant_id,v_site.site_id);
  end loop;
  return NEW;
end $$;
alter function public.powerhub_refresh_purchase_child_headers_after_supplier_update() owner to postgres;
revoke all on function public.powerhub_refresh_purchase_child_headers_after_supplier_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_purchase_child_headers_after_supplier_update() to service_role;

create or replace function public.powerhub_refresh_purchase_headers_after_warehouse_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
begin
  perform public.powerhub_refresh_inventory_purchase_header_delta_scope(NEW.tenant_id,NEW.site_id);
  return NEW;
end $$;
alter function public.powerhub_refresh_purchase_headers_after_warehouse_update() owner to postgres;
revoke all on function public.powerhub_refresh_purchase_headers_after_warehouse_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_purchase_headers_after_warehouse_update() to service_role;

create or replace function public.powerhub_refresh_purchase_child_headers_after_warehouse_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
begin
  perform public.powerhub_refresh_inventory_purchase_receipt_header_delta_scope(NEW.tenant_id,NEW.site_id);
  perform public.powerhub_refresh_inventory_supplier_return_header_delta_scope(NEW.tenant_id,NEW.site_id);
  return NEW;
end $$;
alter function public.powerhub_refresh_purchase_child_headers_after_warehouse_update() owner to postgres;
revoke all on function public.powerhub_refresh_purchase_child_headers_after_warehouse_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_purchase_child_headers_after_warehouse_update() to service_role;


-- Stocktake snapshots are bounded to the newest 200. A deletion or created_at
-- correction must publish the row that moves from rank 201 into the visible set.
create or replace function public.powerhub_refresh_inventory_stocktake_delta_scope(
  p_tenant_id bigint,p_site_id bigint
)
returns void
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_stocktake record;
begin
  if p_tenant_id is null or p_tenant_id<1 or p_site_id is null or p_site_id<1
     or not exists(select 1 from public.sites s where s.tenant_id=p_tenant_id and s.id=p_site_id) then
    raise exception 'POWERHUB_SYNC_SCOPE_INVALID' using errcode='P0001';
  end if;
  for v_stocktake in
    select st.id
    from public.inventory_stocktakes st
    where st.tenant_id=p_tenant_id and st.site_id=p_site_id
    order by st.created_at desc,st.id desc
    limit 200
  loop
    perform public.powerhub_emit_inventory_stocktake_sync_change(p_tenant_id,v_stocktake.id);
  end loop;
end $$;
alter function public.powerhub_refresh_inventory_stocktake_delta_scope(bigint,bigint) owner to postgres;
revoke all on function public.powerhub_refresh_inventory_stocktake_delta_scope(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_inventory_stocktake_delta_scope(bigint,bigint) to service_role;

create or replace function public.powerhub_capture_inventory_stocktake_delta_sync_change()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
declare v_scope_changed boolean:=false; v_rank_changed boolean:=false;
begin
  if TG_OP='DELETE' then
    perform public.powerhub_append_inventory_sync_change(
      OLD.tenant_id,OLD.site_id,'inventory_stocktakes',OLD.id::text,'delete',null
    );
    perform public.powerhub_refresh_inventory_stocktake_delta_scope(OLD.tenant_id,OLD.site_id);
    return OLD;
  end if;

  if TG_OP='UPDATE' then
    if to_jsonb(OLD) is not distinct from to_jsonb(NEW) then return NEW; end if;
    v_scope_changed:=OLD.tenant_id is distinct from NEW.tenant_id
      or OLD.site_id is distinct from NEW.site_id;
    v_rank_changed:=OLD.created_at is distinct from NEW.created_at;
    if v_scope_changed then
      perform public.powerhub_append_inventory_sync_change(
        OLD.tenant_id,OLD.site_id,'inventory_stocktakes',OLD.id::text,'delete',null
      );
      perform public.powerhub_refresh_inventory_stocktake_delta_scope(OLD.tenant_id,OLD.site_id);
    end if;
  end if;

  perform public.powerhub_emit_inventory_stocktake_sync_change(NEW.tenant_id,NEW.id);
  if TG_OP='UPDATE' and (v_scope_changed or v_rank_changed) then
    perform public.powerhub_refresh_inventory_stocktake_delta_scope(NEW.tenant_id,NEW.site_id);
  end if;
  return NEW;
end $$;
alter function public.powerhub_capture_inventory_stocktake_delta_sync_change() owner to postgres;
revoke all on function public.powerhub_capture_inventory_stocktake_delta_sync_change() from public,anon,authenticated;
grant execute on function public.powerhub_capture_inventory_stocktake_delta_sync_change() to service_role;

create or replace function public.powerhub_refresh_stocktake_delta_after_warehouse_update()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,pg_temp
as $$
begin
  perform public.powerhub_refresh_inventory_stocktake_delta_scope(NEW.tenant_id,NEW.site_id);
  return NEW;
end $$;
alter function public.powerhub_refresh_stocktake_delta_after_warehouse_update() owner to postgres;
revoke all on function public.powerhub_refresh_stocktake_delta_after_warehouse_update() from public,anon,authenticated;
grant execute on function public.powerhub_refresh_stocktake_delta_after_warehouse_update() to service_role;

select pg_notify('pgrst','reload schema');
