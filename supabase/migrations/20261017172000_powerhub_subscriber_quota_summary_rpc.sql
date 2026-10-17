-- Collapse the owner subscriber quota preflight into one PostgREST round trip.
-- The create RPCs remain authoritative: they take a tenant-scoped advisory transaction
-- lock and re-check the effective quota atomically before inserting.
create or replace function public.powerhub_subscriber_quota_summary(
  p_tenant_id bigint
)
returns table (
  package_code text,
  current_count integer,
  quota_limit integer
)
language sql
security invoker
set search_path = public, pg_temp
as $function$
  select
    (
      select ts.package_code::text
      from public.tenant_subscriptions ts
      where ts.tenant_id = p_tenant_id
      order by ts.created_at desc
      limit 1
    ) as package_code,
    (
      select count(*)::integer
      from public.subscribers s
      where s.tenant_id = p_tenant_id
        and s.archived_at is null
    ) as current_count,
    public.powerhub_effective_tenant_quota(
      p_tenant_id,
      'subscribers',
      now()
    ) as quota_limit;
$function$;

revoke all on function public.powerhub_subscriber_quota_summary(bigint)
  from public, anon, authenticated;
grant execute on function public.powerhub_subscriber_quota_summary(bigint)
  to service_role;
