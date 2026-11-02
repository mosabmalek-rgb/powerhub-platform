-- Keep unread-count visibility aligned with the tenant-scoped inbox authorization.
-- Roles from tenant A must not grant access to an announcement targeted at tenant B.
create or replace function public.powerhub_platform_announcement_unread_count_for_user(p_user_id bigint)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  with actor as (
    select u.id, u.platform_role
    from public.users u
    where u.id = p_user_id
      and u.account_status = 'active'
  ),
  active_memberships as (
    select tm.tenant_id, tm.user_id, tm.role::text as role
    from public.tenant_members tm
    join actor a on a.id = tm.user_id
    where tm.is_active = true
      and tm.membership_status = 'active'
      and (tm.expires_at is null or tm.expires_at > now())
  ),
  tenant_roles as (
    select am.tenant_id, am.role
    from active_memberships am
    union
    select sp.tenant_id, sp.role::text
    from public.staff_profiles sp
    join active_memberships am
      on am.tenant_id = sp.tenant_id
     and am.user_id = sp.user_id
    where sp.is_active = true
  ),
  global_roles as (
    select tr.role from tenant_roles tr
    union
    select a.platform_role::text from actor a where a.platform_role is not null
    union
    select 'all'::text
  )
  select count(*)::integer
  from public.platform_announcements a
  where exists (select 1 from actor)
    and a.status = 'published'
    and a.published_at is not null
    and a.published_at <= now()
    and (
      (
        a.tenant_id is null
        and a.audience_roles && array(select role from global_roles)
      )
      or
      (
        a.tenant_id is not null
        and (
          a.audience_roles @> array['all']::text[]
          or exists (
            select 1
            from tenant_roles tr
            where tr.tenant_id = a.tenant_id
              and a.audience_roles @> array[tr.role]::text[]
          )
        )
      )
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
