-- Correct inclusive cycle-end conversion to an exact exclusive next boundary.
-- The cycle resolver stores inclusive end instants at microsecond precision.
-- Advancing by 1 millisecond overlaps the next cycle by 999 microseconds.
DO $preflight$
BEGIN
  IF to_regprocedure('public.powerhub_inventory_fuel_consumption_report_period(bigint,bigint,text,date,date,date,bigint,bigint)') IS NULL
     OR to_regprocedure('public.powerhub_cycle_for_reading(bigint,bigint,timestamp with time zone)') IS NULL
     OR to_regprocedure('public.powerhub_inventory_fuel_consumption_report_window(bigint,bigint,timestamp with time zone,timestamp with time zone,bigint,bigint)') IS NULL THEN
    RAISE EXCEPTION 'POWERHUB_FUEL_CYCLE_REPORT_DEPENDENCY_MISSING';
  END IF;
END
$preflight$;

create or replace function public.powerhub_inventory_fuel_consumption_report_period(
  p_tenant_id bigint,p_site_id bigint,p_period_type text,p_anchor_date date,
  p_from_date date,p_to_date date,p_generator_id bigint default null,p_tank_warehouse_id bigint default null
)
returns table(
  generator_id bigint,generator_name text,tank_warehouse_id bigint,tank_name text,
  fuel_filled_liters numeric,fuel_filled_cost numeric,recorded_consumption_liters numeric,
  opening_level_liters numeric,ending_level_liters numeric,
  actual_consumption_liters numeric,opening_operating_hours numeric,ending_operating_hours numeric,
  operating_hours_delta numeric,litres_per_hour numeric,measurement_status text
)
language plpgsql stable security definer set search_path=public,pg_temp
as $function$
declare v_timezone text; v_start_at timestamptz; v_end_at timestamptz; v_cycle record;
begin
  if p_tenant_id is null or p_site_id is null or p_period_type not in ('day','cycle','month','custom') or p_period_type is null then
    raise exception 'INVALID_FUEL_REPORT_PERIOD' using errcode='P0001';
  end if;
  select coalesce((select c.timezone from public.tenant_reading_cycle_configurations c where c.tenant_id=p_tenant_id and c.site_id=p_site_id),'Asia/Gaza')
    into v_timezone;
  if p_period_type in ('day','cycle','month') and p_anchor_date is null then
    raise exception 'FUEL_REPORT_ANCHOR_DATE_REQUIRED' using errcode='P0001';
  end if;
  if p_tank_warehouse_id is not null and not exists (
    select 1 from public.inventory_warehouses w
    where w.tenant_id=p_tenant_id and w.site_id=p_site_id and w.id=p_tank_warehouse_id
      and w.location_type='generator_fuel_tank'
      and (p_generator_id is null or w.generator_id=p_generator_id)
  ) then
    raise exception 'FUEL_REPORT_TANK_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  if p_period_type='day' then
    v_start_at:=p_anchor_date::timestamp at time zone v_timezone;
    v_end_at:=(p_anchor_date+1)::timestamp at time zone v_timezone;
  elsif p_period_type='month' then
    v_start_at:=date_trunc('month',p_anchor_date::timestamp) at time zone v_timezone;
    v_end_at:=(date_trunc('month',p_anchor_date::timestamp)+interval '1 month') at time zone v_timezone;
  elsif p_period_type='cycle' then
    select * into v_cycle from public.powerhub_cycle_for_reading(p_tenant_id,p_site_id,p_anchor_date::timestamp at time zone v_timezone);
    if v_cycle.cycle_start_at is null or v_cycle.cycle_end_at is null then raise exception 'FUEL_REPORT_CYCLE_UNAVAILABLE' using errcode='P0001'; end if;
    v_start_at:=v_cycle.cycle_start_at;
    v_end_at:=v_cycle.cycle_end_at+interval '1 microsecond';
  else
    if p_from_date is null or p_to_date is null or p_from_date>p_to_date then raise exception 'INVALID_FUEL_REPORT_DATE_RANGE' using errcode='P0001'; end if;
    v_start_at:=p_from_date::timestamp at time zone v_timezone;
    v_end_at:=(p_to_date+1)::timestamp at time zone v_timezone;
  end if;
  if v_end_at<=v_start_at then raise exception 'INVALID_FUEL_REPORT_DATE_RANGE' using errcode='P0001'; end if;
  return query select r.* from public.powerhub_inventory_fuel_consumption_report_window(
    p_tenant_id,p_site_id,v_start_at,v_end_at,p_generator_id,p_tank_warehouse_id
  ) r;
end;
$function$;

-- CREATE OR REPLACE preserves the existing owner, grants and SECURITY DEFINER
-- properties of the deployed signature; no table data is modified.
COMMENT ON FUNCTION public.powerhub_inventory_fuel_consumption_report_period(bigint,bigint,text,date,date,date,bigint,bigint) IS
  'Fuel report period wrapper. Cycle end is inclusive at microsecond precision and converted to the exact exclusive next boundary (+1 microsecond).';
