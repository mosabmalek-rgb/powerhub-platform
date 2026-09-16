-- Support operator directory is exposed only to authenticated users who already
-- hold manageSupportChat. Identity is still derived from auth.uid().

create or replace function private.chat_support_users()
returns table (
  id bigint,
  name text,
  email text,
  platform_role text
)
language sql
security definer
set search_path = ''
stable
as $$
  select u.id, u.name, u.email, u.platform_role
  from public.users u
  join private.platform_capability_policies p
    on p.platform_role = u.platform_role
   and p.capability = 'manageSupportChat'
   and p.is_allowed = true
  where u.account_status = 'active'
    and private.powerhub_has_platform_capability('manageSupportChat');
$$;

create or replace function public.chat_support_users()
returns table (
  id bigint,
  name text,
  email text,
  platform_role text
)
language sql
security invoker
set search_path = ''
as $$
  select * from private.chat_support_users();
$$;

revoke execute on function private.chat_support_users() from public, anon, authenticated;
revoke execute on function public.chat_support_users() from public, anon;
grant execute on function public.chat_support_users() to authenticated;
