-- Keep the fuel-cost report's exclusive cycle end aligned with the authoritative
-- cycle resolver. The resolver stores an inclusive end one microsecond before
-- the next cycle; a one-millisecond increment would overlap adjacent cycles.
DO $preflight$
DECLARE
  v_cycle_definition text;
BEGIN
  IF to_regprocedure('public.powerhub_cycle_for_reading(bigint,bigint,timestamp with time zone)') IS NULL
     OR to_regprocedure('public.powerhub_inventory_fuel_consumption_cost_report_period(bigint,bigint,text,date,date,date,bigint)') IS NULL THEN
    RAISE EXCEPTION 'FUEL_COST_CYCLE_ALIGNMENT_PREREQUISITES_MISSING';
  END IF;
  v_cycle_definition:=pg_get_functiondef(
    'public.powerhub_cycle_for_reading(bigint,bigint,timestamp with time zone)'::regprocedure
  );
  IF position('interval ''1 microsecond''' in v_cycle_definition)=0
     OR position('interval ''1 millisecond''' in v_cycle_definition)>0 THEN
    RAISE EXCEPTION 'FUEL_COST_CYCLE_RESOLVER_PRECISION_MISMATCH';
  END IF;
END
$preflight$;

create or replace function public.powerhub_inventory_fuel_consumption_cost_report_period(
  p_tenant_id bigint,
  p_site_id bigint,
  p_period_type text,
  p_anchor_date date,
  p_from_date date,
  p_to_date date,
  p_generator_id bigint default null
)
returns table(
  generator_id bigint,
  generator_name text,
  movement_count bigint,
  recorded_consumption_liters numeric,
  recorded_consumption_cost numeric,
  average_cost_per_liter numeric
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_timezone text;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_cycle record;
begin
  if p_tenant_id is null or p_site_id is null
    or p_period_type is null or p_period_type not in ('day','cycle','month','custom') then
    raise exception 'INVALID_FUEL_COST_REPORT_PERIOD' using errcode='P0001';
  end if;

  if not exists (
    select 1 from public.sites s
    where s.tenant_id=p_tenant_id and s.id=p_site_id
  ) then
    raise exception 'FUEL_COST_REPORT_SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  if p_generator_id is not null and not exists (
    select 1 from public.generators g
    where g.tenant_id=p_tenant_id and g.site_id=p_site_id and g.id=p_generator_id
  ) then
    raise exception 'FUEL_COST_REPORT_GENERATOR_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select coalesce((
    select c.timezone
    from public.tenant_reading_cycle_configurations c
    where c.tenant_id=p_tenant_id and c.site_id=p_site_id
  ),'Asia/Gaza') into v_timezone;

  if p_period_type in ('day','cycle','month') and p_anchor_date is null then
    raise exception 'FUEL_COST_REPORT_ANCHOR_DATE_REQUIRED' using errcode='P0001';
  end if;

  if p_period_type='day' then
    v_start_at:=p_anchor_date::timestamp at time zone v_timezone;
    v_end_at:=(p_anchor_date+1)::timestamp at time zone v_timezone;
  elsif p_period_type='month' then
    v_start_at:=date_trunc('month',p_anchor_date::timestamp) at time zone v_timezone;
    v_end_at:=(date_trunc('month',p_anchor_date::timestamp)+interval '1 month') at time zone v_timezone;
  elsif p_period_type='cycle' then
    select * into v_cycle
    from public.powerhub_cycle_for_reading(p_tenant_id,p_site_id,p_anchor_date::timestamp at time zone v_timezone);
    if v_cycle.cycle_start_at is null or v_cycle.cycle_end_at is null then
      raise exception 'FUEL_COST_REPORT_CYCLE_UNAVAILABLE' using errcode='P0001';
    end if;
    v_start_at:=v_cycle.cycle_start_at;
    v_end_at:=v_cycle.cycle_end_at+interval '1 microsecond';
  else
    if p_from_date is null or p_to_date is null or p_from_date>p_to_date
      or (p_to_date-p_from_date)>365 then
      raise exception 'INVALID_FUEL_COST_REPORT_DATE_RANGE' using errcode='P0001';
    end if;
    v_start_at:=p_from_date::timestamp at time zone v_timezone;
    v_end_at:=(p_to_date+1)::timestamp at time zone v_timezone;
  end if;

  if v_end_at<=v_start_at then
    raise exception 'INVALID_FUEL_COST_REPORT_DATE_RANGE' using errcode='P0001';
  end if;

  return query
  with effective_movements as (
    select m.id,m.generator_id,m.quantity,m.total_cost_amount
    from public.inventory_stock_movements m
    where m.tenant_id=p_tenant_id
      and m.site_id=p_site_id
      and m.generator_id is not null
      and m.movement_type='fuel_consumption'
      and m.occurred_at>=v_start_at
      and m.occurred_at<v_end_at
      and (p_generator_id is null or m.generator_id=p_generator_id)
      -- A corrected fuel-consumption row is reversed by an adjustment_in and replaced
      -- by a fresh fuel_consumption row. Count the replacement only, never both rows.
      and not exists (
        select 1
        from public.inventory_stock_movements reversal
        where reversal.tenant_id=m.tenant_id
          and reversal.site_id=m.site_id
          and reversal.reversal_of_movement_id=m.id
      )
  ),
  totals as (
    select m.generator_id,
      count(*)::bigint as movement_count,
      sum(m.quantity)::numeric(14,3) as recorded_consumption_liters,
      sum(m.total_cost_amount)::numeric(14,2) as recorded_consumption_cost
    from effective_movements m
    group by m.generator_id
  )
  select g.id,g.name,
    coalesce(t.movement_count,0)::bigint,
    coalesce(t.recorded_consumption_liters,0)::numeric(14,3),
    coalesce(t.recorded_consumption_cost,0)::numeric(14,2),
    case when coalesce(t.recorded_consumption_liters,0)>0
      then round(t.recorded_consumption_cost/t.recorded_consumption_liters,4)::numeric(14,4)
      else null::numeric(14,4)
    end
  from public.generators g
  left join totals t on t.generator_id=g.id
  where g.tenant_id=p_tenant_id and g.site_id=p_site_id
    and (p_generator_id is null or g.id=p_generator_id)
  order by g.name,g.id;
end;
$function$;

REVOKE ALL ON FUNCTION public.powerhub_inventory_fuel_consumption_cost_report_period(bigint,bigint,text,date,date,date,bigint)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.powerhub_inventory_fuel_consumption_cost_report_period(bigint,bigint,text,date,date,date,bigint)
  TO service_role;

NOTIFY pgrst,'reload schema';
