-- Aggregate dashboard performance KPIs over every non-archived site in a tenant.
-- Callers must authorize the user's all-branches scope before invoking these service-role-only RPCs.

create or replace function public.powerhub_dashboard_reading_kpis_all_branches(
  p_tenant_id bigint,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with scoped as (
    select mr.status, mr.reading_at, mr.consumption_kwh
    from public.meter_readings mr
    join public.subscribers s
      on s.id = mr.subscriber_id
     and s.tenant_id = mr.tenant_id
    join public.sites st
      on st.id = s.site_id
     and st.tenant_id = s.tenant_id
    where mr.tenant_id = p_tenant_id
      and st.tenant_id = p_tenant_id
      and st.status <> 'archived'
      and mr.reading_at >= p_from
      and mr.reading_at < p_to
  ),
  approved as (
    select reading_at, consumption_kwh
    from scoped
    where status = 'approved'
  )
  select jsonb_build_object(
    'consumption', coalesce((select sum(coalesce(consumption_kwh, 0)) from approved), 0),
    'average', coalesce((select avg(coalesce(consumption_kwh, 0)) from approved), 0),
    'approvedCount', (select count(*) from approved),
    'pendingCount', (select count(*) from scoped where status = 'pending_review'),
    'latestReadingAt', (select max(reading_at) from approved)
  );
$$;

create or replace function public.powerhub_dashboard_collector_performance_all_branches(
  p_tenant_id bigint,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with scoped as (
    select
      cs.collector_user_id,
      cs.status,
      coalesce(cs.expected_cash, 0) as expected_cash,
      coalesce(cs.declared_cash, 0) as declared_cash,
      coalesce(cs.variance_amount, 0) as variance_amount
    from public.collector_sessions cs
    join public.sites st
      on st.id = cs.site_id
     and st.tenant_id = cs.tenant_id
    where cs.tenant_id = p_tenant_id
      and st.tenant_id = p_tenant_id
      and st.status <> 'archived'
      and (
        (cs.opened_at >= p_from and cs.opened_at < p_to)
        or (cs.opened_at is null and cs.closed_at >= p_from and cs.closed_at < p_to)
      )
  ),
  collector_totals as (
    select
      s.collector_user_id,
      coalesce(nullif(max(u.name), ''), max(u.email), 'محصل غير محدد') as name,
      count(*) as sessions,
      sum(s.variance_amount) as variance
    from scoped s
    left join public.users u on u.id = s.collector_user_id
    group by s.collector_user_id
  ),
  top_collectors as (
    select name, sessions, variance
    from collector_totals
    order by abs(variance) desc nulls last, sessions desc
    limit 5
  )
  select jsonb_build_object(
    'openCount', (select count(*) from scoped where status = 'open'),
    'closedCount', (select count(*) from scoped where status = 'closed'),
    'varianceCount', (select count(*) from scoped where status = 'closed' and abs(variance_amount) > 0.01),
    'netVariance', coalesce((select sum(declared_cash - expected_cash) from scoped where status = 'closed'), 0),
    'collectors', coalesce((
      select jsonb_agg(
        jsonb_build_object('name', name, 'sessions', sessions, 'variance', variance)
        order by abs(variance) desc nulls last, sessions desc
      )
      from top_collectors
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.powerhub_dashboard_reading_kpis_all_branches(bigint, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.powerhub_dashboard_collector_performance_all_branches(bigint, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_dashboard_reading_kpis_all_branches(bigint, timestamptz, timestamptz) to service_role;
grant execute on function public.powerhub_dashboard_collector_performance_all_branches(bigint, timestamptz, timestamptz) to service_role;
