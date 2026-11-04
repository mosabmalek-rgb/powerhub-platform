-- Generator tanks are an operational measurement reference, not confirmed inventory.
-- Fuel fills create one issue from the source warehouse; they do not create a
-- second stock balance at the generator tank. Exclude legacy tank ledger rows
-- from general stock balances and re-order metrics.
create or replace function public.powerhub_inventory_stock_overview(p_tenant_id bigint, p_site_id bigint)
returns table(
  warehouse_id bigint,
  warehouse_code text,
  warehouse_name text,
  item_id bigint,
  sku text,
  item_name text,
  category text,
  base_unit text,
  reorder_point numeric,
  on_hand_quantity numeric,
  stock_value numeric,
  average_unit_cost numeric,
  below_reorder_point boolean
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  with balances as (
    select m.tenant_id,m.site_id,m.warehouse_id,m.item_id,
      sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.quantity else -m.quantity end)::numeric(14,3) as on_hand_quantity,
      sum(case when m.movement_type in ('opening_balance','purchase_receipt','adjustment_in','return_from_issue')
        then m.total_cost_amount else -m.total_cost_amount end)::numeric(14,2) as stock_value
    from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id and m.site_id=p_site_id
    group by m.tenant_id,m.site_id,m.warehouse_id,m.item_id
  )
  select w.id,w.code,w.name,i.id,i.sku,i.name,i.category,i.base_unit,i.reorder_point,
    coalesce(b.on_hand_quantity,0)::numeric(14,3),greatest(coalesce(b.stock_value,0),0)::numeric(14,2),
    case when coalesce(b.on_hand_quantity,0)>0
      then (greatest(coalesce(b.stock_value,0),0)/b.on_hand_quantity)::numeric(14,4)
      else 0::numeric end,
    coalesce(b.on_hand_quantity,0)<=i.reorder_point
  from public.inventory_warehouses w
  join public.inventory_items i on i.tenant_id=w.tenant_id and i.is_active=true
  left join balances b on b.tenant_id=w.tenant_id and b.site_id=w.site_id
    and b.warehouse_id=w.id and b.item_id=i.id
  where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.is_active=true
    and w.location_type is distinct from 'generator_fuel_tank'
    and (w.location_type not in ('fixed_fuel_tank','generator_fuel_tank') or i.category='fuel')
    and (coalesce(b.on_hand_quantity,0)>0 or (i.reorder_point>0 and coalesce(b.on_hand_quantity,0)<=i.reorder_point))
  order by (coalesce(b.on_hand_quantity,0)<=i.reorder_point) desc,i.name,w.name
  limit 5000;
$function$;
