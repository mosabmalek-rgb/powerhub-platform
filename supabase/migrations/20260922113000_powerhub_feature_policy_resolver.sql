-- Resolve the effective feature policy for one tenant.
-- The result is used by runtime RPCs so UI-supplied quota values cannot bypass overrides.

create or replace function public.powerhub_resolve_tenant_feature_policy(
  p_tenant_id bigint,
  p_feature_key text
)
returns table(
  feature_key text,
  package_code text,
  package_policy text,
  eligible boolean,
  enabled boolean,
  package_limit integer,
  effective_limit integer,
  effective_limit_mode text,
  control_status text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with subscription as (
    select ts.plan
    from public.tenant_subscriptions ts
    where ts.tenant_id = p_tenant_id
      and ts.status in ('trial','active')
      and (ts.ends_at is null or ts.ends_at > now())
    order by ts.created_at desc
    limit 1
  ),
  package_policy as (
    select p.package_code, p.policy, p.default_limit, p.limit_mode
    from public.package_feature_policies p
    where p.package_code = (select package_code from subscription)
      and p.feature_key = p_feature_key
  ),
  control as (
    select c.status, c.limit_mode, c.manual_limit
    from public.tenant_feature_controls c
    where c.tenant_id = p_tenant_id
      and c.feature_key = p_feature_key
  )
  select
    p_feature_key,
    pp.package_code,
    coalesce(pp.policy, 'not_included') as package_policy,
    coalesce(pp.policy in ('included','addon'), false) as eligible,
    case
      when coalesce(pp.policy in ('included','addon'), false) = false then false
      when coalesce(c.status, 'inherit') = 'enabled' then true
      when coalesce(c.status, 'inherit') = 'disabled' then false
      else pp.policy = 'included'
        and p_feature_key not in ('subscriber_portal_logo','payment_documentation')
    end as enabled,
    pp.default_limit as package_limit,
    case
      when coalesce(c.limit_mode, 'inherit') = 'manual' then c.manual_limit
      when coalesce(c.limit_mode, 'inherit') = 'unlimited' then null
      else pp.default_limit
    end as effective_limit,
    case
      when coalesce(c.limit_mode, 'inherit') = 'manual' then 'manual'
      when coalesce(c.limit_mode, 'inherit') = 'unlimited' then 'unlimited'
      else coalesce(pp.limit_mode, 'inherit')
    end as effective_limit_mode,
    coalesce(c.status, 'inherit') as control_status
  from package_policy pp
  full join control c on true;
$$;

revoke all on function public.powerhub_resolve_tenant_feature_policy(bigint,text)
  from public, anon, authenticated;
grant execute on function public.powerhub_resolve_tenant_feature_policy(bigint,text)
  to service_role;
