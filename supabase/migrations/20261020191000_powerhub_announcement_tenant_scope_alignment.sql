-- Keep tenant-scoped announcements isolated consistently across production and staging.
-- Some existing environments already have tenant_id; others were created from the global-only
-- baseline. Add the nullable scope column where absent and preserve global announcements as NULL.
alter table public.platform_announcements
  add column if not exists tenant_id bigint;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.platform_announcements'::regclass
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) like 'FOREIGN KEY (tenant_id)%'
  ) then
    alter table public.platform_announcements
      add constraint platform_announcements_tenant_id_fkey
      foreign key (tenant_id) references public.tenants(id) on delete cascade;
  end if;
end
$$;

create index if not exists platform_announcements_tenant_id_idx
  on public.platform_announcements(tenant_id);

-- Match the inbox list/read authorization exactly, including active tenant membership.
create or replace function public.powerhub_platform_announcement_unread_count_for_user(p_user_id bigint)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with actor as (
    select u.id, u.role, u.platform_role
    from public.users u
    where u.id = p_user_id
      and u.account_status = 'active'
  ),
  roles as (
    select distinct sp.role::text as role
    from public.staff_profiles sp
    join actor a on a.id = sp.user_id
    where sp.is_active = true
    union
    select a.role::text
    from actor a
    where a.role is not null
    union
    select a.platform_role::text
    from actor a
    where a.platform_role is not null
    union
    select 'all'::text
  ),
  memberships as (
    select tm.tenant_id
    from public.tenant_members tm
    join actor a on a.id = tm.user_id
    where tm.is_active = true
      and tm.membership_status = 'active'
  )
  select count(*)::integer
  from public.platform_announcements a
  where exists (select 1 from actor)
    and a.status = 'published'
    and a.published_at is not null
    and a.published_at <= now()
    and a.audience_roles && array(select role from roles)
    and (
      a.tenant_id is null
      or exists (select 1 from memberships m where m.tenant_id = a.tenant_id)
    )
    and not exists (
      select 1
      from public.platform_announcement_reads ar
      where ar.announcement_id = a.id
        and ar.user_id = p_user_id
    );
$$;

revoke all on function public.powerhub_platform_announcement_unread_count_for_user(bigint) from public, anon, authenticated;
grant execute on function public.powerhub_platform_announcement_unread_count_for_user(bigint) to service_role;
