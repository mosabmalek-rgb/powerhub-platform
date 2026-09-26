create or replace function public.powerhub_advanced_dashboard()
returns table (
  kpis jsonb,
  monthly_growth jsonb,
  consumption_by_region jsonb,
  collections_by_generator jsonb,
  latest_generators jsonb,
  recent_complaints jsonb,
  expiring_subscriptions jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  with boundaries as (
    select
      date_trunc('day', now()) as today_start,
      date_trunc('month', now()) as month_start,
      (date_trunc('month', now()) - interval '11 months')::date as growth_start
  ),
  month_series as (
    select generate_series(boundaries.growth_start, boundaries.month_start::date, interval '1 month')::date as month_start
    from boundaries
  ),
  monthly_growth_counts as (
    select date_trunc('month', subscribers.created_at)::date as month_start, count(*)::bigint as count
    from public.subscribers
    cross join boundaries
    where subscribers.created_at >= boundaries.growth_start
    group by 1
  ),
  site_generator_counts as (
    select generators.site_id, count(*)::bigint as generator_count, min(generators.id) as only_generator_id
    from public.generators
    group by generators.site_id
  ),
  collections_rows as (
    select generators.id as generator_id,
      generators.name as generator_name,
      generators.code as generator_code,
      tenants.name as tenant_name,
      count(payments.id)::bigint as payment_count,
      coalesce(sum(payments.amount), 0)::numeric as amount
    from public.payments
    inner join public.generators
      on generators.site_id = payments.site_id
      and generators.tenant_id = payments.tenant_id
    inner join site_generator_counts
      on site_generator_counts.site_id = generators.site_id
      and site_generator_counts.generator_count = 1
      and site_generator_counts.only_generator_id = generators.id
    inner join public.tenants on tenants.id = generators.tenant_id
    where payments.status = 'completed'
    group by generators.id, generators.name, generators.code, tenants.name
    order by coalesce(sum(payments.amount), 0) desc, generators.id
    limit 10
  ),
  region_rows as (
    select coalesce(sites.city, 'غير محدد') as region,
      coalesce(sum(readings.consumption_kwh), 0)::numeric as consumption_kwh
    from public.meter_readings as readings
    inner join public.subscribers on subscribers.id = readings.subscriber_id
    inner join public.sites on sites.id = subscribers.site_id
    where readings.status = 'approved'
    group by sites.city
    order by coalesce(sum(readings.consumption_kwh), 0) desc
    limit 12
  ),
  latest_generator_rows as (
    select generators.id, generators.name, generators.code, generators.status, generators.created_at,
      tenants.name as tenant_name
    from public.generators
    inner join public.tenants on tenants.id = generators.tenant_id
    order by generators.created_at desc
    limit 8
  ),
  complaint_rows as (
    select complaints.id, complaints.title, complaints.priority, complaints.status, complaints.opened_at,
      tenants.name as tenant_name, sites.name as site_name
    from public.complaints
    inner join public.tenants on tenants.id = complaints.tenant_id
    inner join public.sites on sites.id = complaints.site_id
    order by complaints.opened_at desc
    limit 8
  ),
  expiring_subscription_rows as (
    select subscriptions.tenant_id, tenants.name as tenant_name, owners.full_name as owner_name,
      subscriptions.ends_at, subscriptions.status
    from public.tenant_subscriptions as subscriptions
    inner join public.tenants on tenants.id = subscriptions.tenant_id
    left join public.tenant_owner_profiles as owners on owners.tenant_id = tenants.id
    where subscriptions.ends_at is not null
      and subscriptions.ends_at >= now()
      and subscriptions.status in ('trial', 'active', 'overdue')
      and subscriptions.archived_at is null
    order by subscriptions.ends_at asc
    limit 8
  )
  select
    jsonb_build_object(
      'activeGenerators', (select count(*)::bigint from public.generators where status = 'active'),
      'subscribers', (select count(*)::bigint from public.subscribers),
      'dailyConsumption', coalesce((select sum(readings.consumption_kwh) from public.meter_readings as readings, boundaries where readings.status = 'approved' and readings.reading_at >= boundaries.today_start), 0),
      'monthlyConsumption', coalesce((select sum(readings.consumption_kwh) from public.meter_readings as readings, boundaries where readings.status = 'approved' and readings.reading_at >= boundaries.month_start), 0),
      'monthlyCollections', coalesce((select sum(payments.amount) from public.payments as payments, boundaries where payments.status = 'completed' and payments.paid_at >= boundaries.month_start), 0),
      'openComplaints', (select count(*)::bigint from public.complaints where status in ('open', 'assigned', 'in_progress')),
      'generatorsToReview', (select count(*)::bigint from public.generators where status in ('maintenance', 'stopped', 'offline', 'blocked')),
      'collectionRate', coalesce((
        select round(
          100.0 * coalesce(sum(paid_amount) filter (where status in ('paid', 'partially_paid')), 0)
          / nullif(coalesce(sum(total_amount) filter (where status in ('issued', 'partially_paid', 'paid', 'overdue')), 0), 0)
        )
        from public.invoices
      ), 0)
    ),
    coalesce((
      select jsonb_agg(jsonb_build_object('month', to_char(month_series.month_start, 'YYYY-MM'), 'count', coalesce(monthly_growth_counts.count, 0)::bigint) order by month_series.month_start)
      from month_series
      left join monthly_growth_counts on monthly_growth_counts.month_start = month_series.month_start
    ), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('region', region, 'consumptionKwh', consumption_kwh) order by consumption_kwh desc) from region_rows), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('generatorId', generator_id, 'generatorName', generator_name, 'code', generator_code, 'tenantName', tenant_name, 'count', payment_count, 'amount', amount) order by amount desc, generator_id) from collections_rows), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'status', status, 'createdAt', created_at, 'tenantName', tenant_name) order by created_at desc) from latest_generator_rows), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'priority', priority, 'status', status, 'tenantName', tenant_name, 'siteName', site_name, 'openedAt', opened_at) order by opened_at desc) from complaint_rows), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('tenantId', tenant_id, 'tenantName', tenant_name, 'ownerName', owner_name, 'endsAt', ends_at, 'status', status) order by ends_at asc) from expiring_subscription_rows), '[]'::jsonb);
$$;

revoke execute on function public.powerhub_advanced_dashboard() from public, anon, authenticated;
grant execute on function public.powerhub_advanced_dashboard() to service_role;
