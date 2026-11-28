\set ON_ERROR_STOP on

-- This test runs in a disposable PostgreSQL database. It creates only local
-- fixtures and never touches the connected Staging or Production databases.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$roles$;

create table public.users (
  id bigint primary key,
  role text,
  platform_role text,
  account_status text not null
);

create table public.tenant_members (
  tenant_id bigint not null,
  user_id bigint not null,
  role text not null,
  is_active boolean not null,
  membership_status text not null,
  expires_at timestamptz
);

create table public.staff_profiles (
  tenant_id bigint not null,
  user_id bigint not null,
  role text not null,
  is_active boolean not null
);

create table public.platform_announcements (
  id bigint primary key,
  tenant_id bigint,
  status text not null,
  published_at timestamptz,
  audience_roles text[] not null
);

create table public.platform_announcement_reads (
  announcement_id bigint not null,
  user_id bigint not null,
  read_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

\ir ../migrations/20261102193411_powerhub_announcement_tenant_all_membership_guard.sql

insert into public.users (id, role, platform_role, account_status) values
  (1, 'owner', 'platform_admin', 'active'),
  (2, 'basic_user', null, 'active'),
  (3, 'owner', 'platform_admin', 'suspended');

insert into public.tenant_members (tenant_id, user_id, role, is_active, membership_status, expires_at) values
  (10, 1, 'owner', true, 'active', null),
  (20, 1, 'member', true, 'active', null),
  (30, 1, 'owner', true, 'active', now() - interval '1 minute');

insert into public.staff_profiles (tenant_id, user_id, role, is_active) values
  (10, 1, 'manager', true),
  (20, 1, 'viewer', true),
  (30, 1, 'manager', true);

insert into public.platform_announcements (id, tenant_id, status, published_at, audience_roles) values
  (1, null, 'published', now() - interval '1 hour', array['platform_admin']::text[]),
  (2, null, 'published', now() - interval '1 hour', array['owner']::text[]),
  (3, null, 'published', now() - interval '1 hour', array['all']::text[]),
  (4, 10, 'published', now() - interval '1 hour', array['manager']::text[]),
  (5, 10, 'published', now() - interval '1 hour', array['owner']::text[]),
  (6, 10, 'published', now() - interval '1 hour', array['viewer']::text[]),
  (7, 20, 'published', now() - interval '1 hour', array['manager']::text[]),
  (8, 20, 'published', now() - interval '1 hour', array['viewer']::text[]),
  (9, 20, 'published', now() - interval '1 hour', array['owner']::text[]),
  (10, 20, 'published', now() - interval '1 hour', array['platform_admin']::text[]),
  (11, 20, 'published', now() - interval '1 hour', array['all']::text[]),
  (12, 30, 'published', now() - interval '1 hour', array['all']::text[]),
  (13, 40, 'published', now() - interval '1 hour', array['all']::text[]),
  (14, null, 'published', now() - interval '1 hour', array['all']::text[]);

-- The viewer announcement is already read and must not contribute to unread count.
insert into public.platform_announcement_reads (announcement_id, user_id)
values (8, 1);

do $assertions$
declare
  active_tenant_user_count integer;
  unscoped_user_count integer;
  suspended_user_count integer;
  fn_oid oid;
begin
  active_tenant_user_count := public.powerhub_platform_announcement_unread_count_for_user(1);
  if active_tenant_user_count <> 7 then
    raise exception 'Expected 7 unread announcements for user 1, got %', active_tenant_user_count;
  end if;

  unscoped_user_count := public.powerhub_platform_announcement_unread_count_for_user(2);
  if unscoped_user_count <> 2 then
    raise exception 'Expected only 2 global all announcements for user 2 without tenant membership, got %', unscoped_user_count;
  end if;

  suspended_user_count := public.powerhub_platform_announcement_unread_count_for_user(3);
  if suspended_user_count <> 0 then
    raise exception 'Expected 0 unread announcements for suspended user 3, got %', suspended_user_count;
  end if;

  select p.oid into fn_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'powerhub_platform_announcement_unread_count_for_user'
    and pg_get_function_identity_arguments(p.oid) = 'p_user_id bigint';

  if fn_oid is null then
    raise exception 'Unread-count function was not created';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = fn_oid) then
    raise exception 'Unread-count function must remain SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', fn_oid, 'EXECUTE') then
    raise exception 'anon must not execute the unread-count function';
  end if;
  if has_function_privilege('authenticated', fn_oid, 'EXECUTE') then
    raise exception 'authenticated must not execute the unread-count function';
  end if;
  if not has_function_privilege('service_role', fn_oid, 'EXECUTE') then
    raise exception 'service_role must execute the unread-count function';
  end if;
end
$assertions$;

select
  'platform announcement tenant role scope integration passed' as test,
  public.powerhub_platform_announcement_unread_count_for_user(1) as scoped_user_unread_count,
  public.powerhub_platform_announcement_unread_count_for_user(2) as unscoped_user_global_unread_count,
  public.powerhub_platform_announcement_unread_count_for_user(3) as suspended_user_unread_count;
