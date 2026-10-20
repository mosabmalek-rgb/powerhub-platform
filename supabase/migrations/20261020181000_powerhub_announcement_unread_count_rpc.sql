-- Exact announcement unread count in one database round-trip.
-- This helper accepts a user ID only because it is executable by service_role,
-- never by browser roles. The server calls it only after authenticated tRPC middleware.
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
  roles as (
    select distinct sp.role::text as role
    from public.staff_profiles sp
    join actor a on a.id = sp.user_id
    where sp.is_active = true
    union
    select a.platform_role::text as role
    from actor a
    where a.platform_role is not null
    union
    select 'all'::text
  )
  select count(*)::integer
  from public.platform_announcements a
  where exists (select 1 from actor)
    and a.status = 'published'
    and a.published_at is not null
    and a.published_at <= now()
    and a.audience_roles && array(select role from roles)
    and not exists (
      select 1
      from public.platform_announcement_reads ar
      where ar.announcement_id = a.id
        and ar.user_id = p_user_id
    );
$$;

revoke all on function public.powerhub_platform_announcement_unread_count_for_user(bigint) from public, anon, authenticated;
grant execute on function public.powerhub_platform_announcement_unread_count_for_user(bigint) to service_role;
