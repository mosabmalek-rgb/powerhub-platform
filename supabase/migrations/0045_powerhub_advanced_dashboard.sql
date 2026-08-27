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
set search_path = public
as $$
  with boundaries as (
    select date_trunc('day', now()) as today_start,
      date_trunc('month', now()) as month_start,
      date_trunc('month', now()) - interval '11 months' as growth_start
  ), monthly_growth_rows as (
    select to_char(subscribers.created_at, 'YYYY-MM') as month, count(*)::bigint as count
    from public.subscribers, boundaries
    where subscribers.created_at >= boundaries.growth_start
    group by to_char(subscribers.created_at, 'YYYY-MM')
    order by to_char(subscribers.created_at, 'YYYY-MM')
  ), region_rows as (
    select coalesce(sites.city, 'غير محدد') as region,
      coalesce(sum(readings.consumption_kwh), 0)::numeric as consumption_kwh
    from public.meter_readings as readings
    inner join public.subscribers on subscribers.id = readings.subscriber_id
    inner join public.sites on sites.id = subscribers.site_id
    where readings.status = 'approved'
    group by sites.city
    order by coalesce(sum(readings.consumption_kwh), 0) desc
    limit 12
  ), latest_generator_rows as (
    select generators.id, generators.name, generators.code, generators.status, generators.created_at,
      tenants.name as tenant_name
    from public.generators
    inner join public.tenants on tenants.id = generators.tenant_id
    order by generators.created_at desc
    limit 8
  ), complaint_rows as (
    select complaints.id, complaints.title, complaints.priority, complaints.status, complaints.opened_at,
      tenants.name as tenant_name, sites.name as site_name
    from public.complaints
    inner join public.tenants on tenants.id = complaints.tenant_id
    inner join public.sites on sites.id = complaints.site_id
    order by complaints.opened_at desc
    limit 8
  ), expiring_subscription_rows as (
    select subscriptions.tenant_id, tenants.name as tenant_name, owners.full_name as owner_name,
      subscriptions.ends_at, subscriptions.status
    from public.tenant_subscriptions as subscriptions
    inner join public.tenants on tenants.id = subscriptions.tenant_id
    left join public.tenant_owner_profiles as owners on owners.tenant_id = tenants.id
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
    coalesce((select jsonb_agg(jsonb_build_object('month', month, 'count', count) order by month) from monthly_growth_rows), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('region', region, 'consumptionKwh', consumption_kwh) order by consumption_kwh desc) from region_rows), '[]'::jsonb),
    '[]'::jsonb,
    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'code', code, 'status', status, 'createdAt', created_at, 'tenantName', tenant_name) order by created_at desc) from latest_generator_rows), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'priority', priority, 'status', status, 'tenantName', tenant_name, 'siteName', site_name, 'openedAt', opened_at) order by opened_at desc) from complaint_rows), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('tenantId', tenant_id, 'tenantName', tenant_name, 'ownerName', owner_name, 'endsAt', ends_at, 'status', status) order by ends_at asc) from expiring_subscription_rows), '[]'::jsonb);
$$;

revoke execute on function public.powerhub_advanced_dashboard() from public, anon, authenticated;
grant execute on function public.powerhub_advanced_dashboard() to service_role;
