-- Upgrade-request listing reads package-code columns while preserving API result names.

create or replace function public.powerhub_admin_subscription_upgrade_requests()
returns table (
  id bigint,
  tenant_id bigint,
  current_package_code text,
  requested_package_code text,
  status text,
  note text,
  created_at timestamptz,
  reviewed_at timestamptz,
  tenant_name text,
  owner_name text,
  owner_email text
)
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select
    r.id,
    r.tenant_id,
    r.current_package_code::text,
    r.requested_package_code::text,
    r.status::text,
    r.note,
    r.created_at,
    r.reviewed_at,
    t.name::text,
    p.full_name::text,
    p.email::text
  from public.subscription_upgrade_requests r
  left join public.tenants t on t.id=r.tenant_id
  left join public.tenant_owner_profiles p on p.tenant_id=r.tenant_id
  order by r.created_at desc
  limit 300;
$$;

revoke all on function public.powerhub_admin_subscription_upgrade_requests()
  from public, anon, authenticated;
grant execute on function public.powerhub_admin_subscription_upgrade_requests()
  to service_role;
