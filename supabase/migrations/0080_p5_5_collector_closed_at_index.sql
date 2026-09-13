-- P5.5: support fallback-to-closed_at filtering for collector sessions.
create index if not exists collector_sessions_site_closed_at_idx
  on public.collector_sessions (site_id, closed_at desc);

create or replace function public.powerhub_dashboard_collector_performance(
  p_tenant_id bigint,
  p_site_id bigint,
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
    where cs.tenant_id = p_tenant_id
      and cs.site_id = p_site_id
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
      select jsonb_agg(jsonb_build_object('name', name, 'sessions', sessions, 'variance', variance)
        order by abs(variance) desc nulls last, sessions desc)
      from top_collectors
    ), '[]'::jsonb)
  );
$$;
