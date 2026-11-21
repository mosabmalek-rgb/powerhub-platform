-- Reconcile optional tank-level diagnostics with fuel fills that are
-- recorded as direct source-warehouse issues rather than tank stock transfers.
create or replace function public.powerhub_inventory_fuel_consumption_report_window(
  p_tenant_id bigint,p_site_id bigint,p_start_at timestamptz,p_end_at timestamptz,p_generator_id bigint default null,p_tank_warehouse_id bigint default null
)
returns table(
  generator_id bigint,generator_name text,tank_warehouse_id bigint,tank_name text,
  fuel_filled_liters numeric,fuel_filled_cost numeric,recorded_consumption_liters numeric,
  opening_level_liters numeric,ending_level_liters numeric,
  actual_consumption_liters numeric,opening_operating_hours numeric,ending_operating_hours numeric,
  operating_hours_delta numeric,litres_per_hour numeric,measurement_status text
)
language sql
stable
security definer
set search_path=public,pg_temp
as $function$
with scope as (
  select p_tenant_id tenant_id,p_site_id site_id,p_start_at start_at,p_end_at end_at
),
tanks as (
  select g.tenant_id,g.site_id,g.id generator_id,g.name generator_name,w.id tank_warehouse_id,w.name tank_name
  from public.generators g join public.inventory_warehouses w
    on w.tenant_id=g.tenant_id and w.site_id=g.site_id and w.generator_id=g.id
      and w.location_type='generator_fuel_tank'
  where g.tenant_id=p_tenant_id and g.site_id=p_site_id and (p_generator_id is null or g.id=p_generator_id)
    and (p_tank_warehouse_id is null or w.id=p_tank_warehouse_id)
),
levels as (
  select t.*,
    (select r.reading_value from public.generator_fuel_readings r
      where r.tenant_id=t.tenant_id and r.site_id=t.site_id and r.generator_id=t.generator_id
        and r.reading_type='tank_level' and r.tank_warehouse_id=t.tank_warehouse_id
        and not exists (
          select 1 from public.generator_fuel_readings corrected
          where corrected.tenant_id=r.tenant_id and corrected.corrects_reading_id=r.id
        )
        and r.recorded_at<=(select start_at from scope)
      order by r.recorded_at desc,r.id desc limit 1) opening_level,
    (select r.reading_value from public.generator_fuel_readings r
      where r.tenant_id=t.tenant_id and r.site_id=t.site_id and r.generator_id=t.generator_id
        and r.reading_type='tank_level' and r.tank_warehouse_id=t.tank_warehouse_id
        and not exists (
          select 1 from public.generator_fuel_readings corrected
          where corrected.tenant_id=r.tenant_id and corrected.corrects_reading_id=r.id
        )
        and r.recorded_at<(select end_at from scope)
      order by r.recorded_at desc,r.id desc limit 1) ending_level,
    (select r.reading_value from public.generator_fuel_readings r
      where r.tenant_id=t.tenant_id and r.site_id=t.site_id and r.generator_id=t.generator_id
        and r.reading_type='operating_hours' and r.recorded_at<=(select start_at from scope)
        and not exists (
          select 1 from public.generator_fuel_readings corrected
          where corrected.tenant_id=r.tenant_id and corrected.corrects_reading_id=r.id
        )
      order by r.recorded_at desc,r.id desc limit 1) opening_hours,
    (select r.reading_value from public.generator_fuel_readings r
      where r.tenant_id=t.tenant_id and r.site_id=t.site_id and r.generator_id=t.generator_id
        and r.reading_type='operating_hours' and r.recorded_at<(select end_at from scope)
        and not exists (
          select 1 from public.generator_fuel_readings corrected
          where corrected.tenant_id=r.tenant_id and corrected.corrects_reading_id=r.id
        )
      order by r.recorded_at desc,r.id desc limit 1) ending_hours
  from tanks t
),
fills as (
  select e.tenant_id,e.site_id,e.generator_id,e.destination_warehouse_id tank_warehouse_id,
    sum(e.litres)::numeric(14,3) filled_liters,
    sum(e.litres) filter (where e.stock_transfer_id is null)::numeric(14,3) untransferred_filled_liters,
    sum(e.total_cost_amount)::numeric(14,2) filled_cost
  from public.generator_fuel_events e,scope s
  where e.tenant_id=s.tenant_id and e.site_id=s.site_id
    and e.occurred_at>=s.start_at and e.occurred_at<s.end_at
    and (p_generator_id is null or e.generator_id=p_generator_id)
  group by e.tenant_id,e.site_id,e.generator_id,e.destination_warehouse_id
),
movements as (
  select m.tenant_id,m.site_id,m.warehouse_id tank_warehouse_id,
    sum(case
      when m.movement_type in ('opening_balance','purchase_receipt','return_from_issue') then m.quantity
      when m.movement_type='adjustment_in' and exists(
        select 1 from public.inventory_stock_transfers t
        where t.tenant_id=m.tenant_id and t.destination_movement_id=m.id
      ) then m.quantity
      else 0 end)::numeric(14,3) as inflows,
    sum(case when m.movement_type in ('issue','supplier_return') then m.quantity else 0 end)::numeric(14,3) as outflows,
    sum(case when m.movement_type='fuel_consumption' then m.quantity else 0 end)::numeric(14,3) as recorded_consumption_liters,
    coalesce(bool_or(
      m.movement_type in ('adjustment_in','adjustment_out')
      and not exists(
        select 1 from public.inventory_stock_transfers t
        where t.tenant_id=m.tenant_id and (t.source_movement_id=m.id or t.destination_movement_id=m.id)
      )
      and not exists(
        select 1 from public.inventory_stocktake_lines l
        where l.tenant_id=m.tenant_id and l.posted_movement_id=m.id
      )
    ),false) as has_unlinked_adjustment
  from public.inventory_stock_movements m
  join scope s on m.tenant_id=s.tenant_id and m.site_id=s.site_id
  join public.inventory_warehouses w on w.tenant_id=m.tenant_id and w.site_id=m.site_id and w.id=m.warehouse_id
  left join public.inventory_stock_transfers fill_transfer
    on fill_transfer.tenant_id=m.tenant_id and fill_transfer.destination_movement_id=m.id
  left join public.generator_fuel_events fill_event
    on fill_event.tenant_id=fill_transfer.tenant_id and fill_event.stock_transfer_id=fill_transfer.id
  where m.tenant_id=s.tenant_id and m.site_id=s.site_id
    and w.location_type='generator_fuel_tank'
    and coalesce(fill_event.occurred_at,m.occurred_at)>=s.start_at
    and coalesce(fill_event.occurred_at,m.occurred_at)<s.end_at
  group by m.tenant_id,m.site_id,m.warehouse_id
)
select l.generator_id,l.generator_name,l.tank_warehouse_id,l.tank_name,
  coalesce(f.filled_liters,0)::numeric(14,3),coalesce(f.filled_cost,0)::numeric(14,2),
  coalesce(m.recorded_consumption_liters,0)::numeric(14,3),
  l.opening_level,l.ending_level,
  case when l.opening_level is null or l.ending_level is null
        or coalesce(m.has_unlinked_adjustment,false) then null
    when l.opening_level+coalesce(m.inflows,0)+coalesce(f.untransferred_filled_liters,0)-coalesce(m.outflows,0)-l.ending_level<0 then null
    else (l.opening_level+coalesce(m.inflows,0)+coalesce(f.untransferred_filled_liters,0)-coalesce(m.outflows,0)-l.ending_level)::numeric(14,3) end,
  l.opening_hours,l.ending_hours,
  case when l.opening_hours is not null and l.ending_hours>l.opening_hours then (l.ending_hours-l.opening_hours)::numeric(14,3) else null end,
  case when l.opening_level is not null and l.ending_level is not null
      and not coalesce(m.has_unlinked_adjustment,false)
      and l.opening_level+coalesce(m.inflows,0)+coalesce(f.untransferred_filled_liters,0)-coalesce(m.outflows,0)-l.ending_level>=0
      and l.opening_hours is not null and l.ending_hours>l.opening_hours
    then round((l.opening_level+coalesce(m.inflows,0)+coalesce(f.untransferred_filled_liters,0)-coalesce(m.outflows,0)-l.ending_level)/(l.ending_hours-l.opening_hours),3)::numeric(14,3)
    else null end,
  case when l.opening_level is null or l.ending_level is null then 'insufficient_level_readings'
    when coalesce(m.has_unlinked_adjustment,false) then 'reconciliation_anomaly'
    when l.opening_level+coalesce(m.inflows,0)+coalesce(f.untransferred_filled_liters,0)-coalesce(m.outflows,0)-l.ending_level<0 then 'reconciliation_anomaly'
    when l.opening_hours is null or l.ending_hours<=l.opening_hours then 'measured_without_hour_rate'
    else 'measured' end
from levels l
left join fills f on f.tenant_id=l.tenant_id and f.site_id=l.site_id and f.generator_id=l.generator_id and f.tank_warehouse_id=l.tank_warehouse_id
left join movements m on m.tenant_id=l.tenant_id and m.site_id=l.site_id and m.tank_warehouse_id=l.tank_warehouse_id
order by l.generator_name,l.tank_name;
$function$;

COMMENT ON FUNCTION public.powerhub_inventory_fuel_consumption_report_window(bigint,bigint,timestamptz,timestamptz,bigint,bigint)
  IS 'Fuel fills are included in optional tank-level reconciliation even when the fill is a direct issue from the source warehouse; periodic tank readings are not required for fuel cost recognition.';

NOTIFY pgrst, 'reload schema';
