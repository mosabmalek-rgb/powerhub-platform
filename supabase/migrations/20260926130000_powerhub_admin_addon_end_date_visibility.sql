drop function if exists public.powerhub_admin_tenant_addon_requests();

create function public.powerhub_admin_tenant_addon_requests()
returns table(
 id bigint,
 tenant_id bigint,
 site_id bigint,
 addon_code text,
 quantity integer,
 status text,
 note text,
 created_at timestamptz,
 reviewed_at timestamptz,
 starts_at timestamptz,
 ends_at timestamptz,
 tenant_name text,
 owner_name text,
 owner_email text
)
language sql
security definer
set search_path=public,pg_temp
as $$
  select
    r.id,
    r.tenant_id,
    r.site_id,
    r.addon_code,
    r.quantity,
    r.status,
    r.note,
    r.created_at,
    r.reviewed_at,
    r.starts_at,
    r.ends_at,
    t.name,
    op.full_name,
    op.email
  from public.tenant_addon_requests r
  join public.tenants t on t.id=r.tenant_id
  left join public.tenant_owner_profiles op on op.tenant_id=r.tenant_id
  order by r.created_at desc
  limit 500
$$;

revoke all on function public.powerhub_admin_tenant_addon_requests() from public,anon,authenticated;
grant execute on function public.powerhub_admin_tenant_addon_requests() to service_role;
