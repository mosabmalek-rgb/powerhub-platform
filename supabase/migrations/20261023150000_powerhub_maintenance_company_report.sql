-- Phase C closure: tenant-owner report across all branches.
-- Branch-scoped reports remain unchanged. The caller's tenant is derived in the server router.
create or replace function public.powerhub_maintenance_company_report_by_generator(
  p_tenant_id bigint,
  p_from_date date,
  p_to_date date,
  p_generator_id bigint default null
)
returns table(
  site_id bigint,
  site_name text,
  generator_id bigint,
  generator_name text,
  fault_title text,
  work_order_count bigint,
  breakdown_count bigint,
  preventive_count bigint,
  completed_count bigint,
  open_count bigint,
  downtime_minutes bigint,
  parts_cost numeric,
  labor_cost numeric,
  external_service_cost numeric,
  total_cost_amount numeric,
  first_reported_at timestamptz,
  last_reported_at timestamptz
)
language plpgsql
stable
security invoker
set search_path=public,pg_temp
as $maintenance_company_report$
begin
  if p_tenant_id is null or p_from_date is null or p_to_date is null
     or p_from_date>p_to_date or (p_to_date-p_from_date)>365 then
    raise exception 'INVALID_MAINTENANCE_REPORT_RANGE' using errcode='P0001';
  end if;

  if p_generator_id is not null and not exists(
    select 1 from public.generators g
    where g.tenant_id=p_tenant_id and g.id=p_generator_id
  ) then
    raise exception 'MAINTENANCE_GENERATOR_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  return query
  select
    w.site_id,
    s.name as site_name,
    w.generator_id,
    g.name as generator_name,
    min(btrim(w.title)) as fault_title,
    count(*)::bigint as work_order_count,
    count(*) filter(where w.order_type='breakdown')::bigint as breakdown_count,
    count(*) filter(where w.order_type='preventive')::bigint as preventive_count,
    count(*) filter(where w.status='completed')::bigint as completed_count,
    count(*) filter(where w.status in ('scheduled','new','in_progress','waiting_for_parts'))::bigint as open_count,
    coalesce(sum(w.downtime_minutes),0)::bigint as downtime_minutes,
    coalesce(sum(w.parts_cost),0)::numeric as parts_cost,
    coalesce(sum(w.labor_cost),0)::numeric as labor_cost,
    coalesce(sum(w.external_service_cost),0)::numeric as external_service_cost,
    coalesce(sum(w.total_cost_amount),0)::numeric as total_cost_amount,
    min(coalesce(w.reported_at,w.created_at)) as first_reported_at,
    max(coalesce(w.reported_at,w.created_at)) as last_reported_at
  from public.generator_maintenance_work_orders w
  join public.sites s on s.tenant_id=w.tenant_id and s.id=w.site_id
  join public.generators g on g.tenant_id=w.tenant_id and g.site_id=w.site_id and g.id=w.generator_id
  left join public.tenant_reading_cycle_configurations c
    on c.tenant_id=w.tenant_id and c.site_id=w.site_id
  where w.tenant_id=p_tenant_id
    and (p_generator_id is null or w.generator_id=p_generator_id)
    and coalesce(w.reported_at,w.created_at) >= (
      p_from_date::timestamp at time zone coalesce(nullif(btrim(c.timezone),''),'Asia/Gaza')
    )
    and coalesce(w.reported_at,w.created_at) < (
      (p_to_date+1)::timestamp at time zone coalesce(nullif(btrim(c.timezone),''),'Asia/Gaza')
    )
  group by w.site_id,s.name,w.generator_id,g.name,
    lower(regexp_replace(btrim(w.title),'[[:space:]]+',' ','g'))
  order by s.name,g.name,count(*) desc,
    min(coalesce(w.reported_at,w.created_at)) desc;
end;
$maintenance_company_report$;

revoke all on function public.powerhub_maintenance_company_report_by_generator(bigint,date,date,bigint)
  from public,anon,authenticated;
grant execute on function public.powerhub_maintenance_company_report_by_generator(bigint,date,date,bigint)
  to service_role;

notify pgrst, 'reload schema';
