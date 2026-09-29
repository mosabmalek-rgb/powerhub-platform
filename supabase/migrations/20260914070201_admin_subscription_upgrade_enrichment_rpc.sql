create or replace function public.powerhub_admin_subscription_upgrade_requests()
returns table (
  id bigint,
  tenant_id bigint,
  current_plan text,
  requested_plan text,
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
set search_path = public, pg_temp
as $$
  select
    r.id,
    r.tenant_id,
    r.current_plan::text,
    r.requested_plan::text,
    r.status::text,
    r.note,
    r.created_at,
    r.reviewed_at,
    t.name::text as tenant_name,
    p.full_name::text as owner_name,
    p.email::text as owner_email
  from public.subscription_upgrade_requests r
  left join public.tenants t on t.id = r.tenant_id
  left join public.tenant_owner_profiles p on p.tenant_id = r.tenant_id
  order by r.created_at desc
  limit 300;
$$;
revoke all on function public.powerhub_admin_subscription_upgrade_requests() from public;
grant execute on function public.powerhub_admin_subscription_upgrade_requests() to service_role;
