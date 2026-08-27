create or replace function public.powerhub_finance_overview()
returns table (
  subscriptions jsonb,
  collections_amount numeric,
  collections_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce((
      select jsonb_agg(
        jsonb_build_object('status', subscription_status.status, 'count', subscription_status.count)
        order by subscription_status.status
      )
      from (
        select status, count(*)::bigint as count
        from public.tenant_subscriptions
        group by status
      ) as subscription_status
    ), '[]'::jsonb),
    coalesce((
      select sum(amount)
      from public.payments
      where status = 'completed'
    ), 0)::numeric,
    coalesce((
      select count(*)::bigint
      from public.payments
      where status = 'completed'
    ), 0)::bigint;
$$;

revoke execute on function public.powerhub_finance_overview() from public, anon, authenticated;
grant execute on function public.powerhub_finance_overview() to service_role;
