-- Target platform announcements to a single generator-owner tenant.
alter table if exists public.platform_announcements
  add column if not exists tenant_id bigint null references public.tenants(id) on delete cascade;

create index if not exists platform_announcements_tenant_published_idx
  on public.platform_announcements(tenant_id, status, published_at desc, id desc);
