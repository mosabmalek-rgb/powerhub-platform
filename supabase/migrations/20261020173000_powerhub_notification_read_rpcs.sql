-- Secure, bounded read API for the unified notification inbox.
-- Clients never receive direct table privileges; each RPC derives identity from auth.uid().
create or replace function public.powerhub_notification_list(p_limit integer default 20)
returns table (
  id bigint, notification_type text, title text, body text, target_path text,
  metadata jsonb, read_at timestamptz, created_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare v_user_id bigint; v_limit integer;
begin
  select u.id into v_user_id from public.users u where u.auth_user_id = auth.uid();
  if v_user_id is null then raise exception 'UNAUTHORIZED' using errcode = '42501'; end if;
  v_limit := greatest(1, least(coalesce(p_limit,20),100));
  return query
    select n.id,n.notification_type,n.title,n.body,n.target_path,n.metadata,n.read_at,n.created_at
    from public.powerhub_user_notifications n
    where n.user_id = v_user_id
    order by n.created_at desc,n.id desc
    limit v_limit;
end;
$$;
revoke all on function public.powerhub_notification_list(integer) from public, anon;
grant execute on function public.powerhub_notification_list(integer) to authenticated;

create or replace function public.powerhub_notification_unread_count()
returns integer language plpgsql stable security definer set search_path = '' as $$
declare v_user_id bigint; v_count integer;
begin
  select u.id into v_user_id from public.users u where u.auth_user_id = auth.uid();
  if v_user_id is null then raise exception 'UNAUTHORIZED' using errcode = '42501'; end if;
  select count(*)::integer into v_count from public.powerhub_user_notifications n
    where n.user_id = v_user_id and n.read_at is null;
  return coalesce(v_count,0);
end;
$$;
revoke all on function public.powerhub_notification_unread_count() from public, anon;
grant execute on function public.powerhub_notification_unread_count() to authenticated;

-- Chat inbox badge/read-all APIs: derive the recipient from the authenticated session.
-- The indexed (user_id, read_at, created_at) access path keeps both operations bounded
-- to the current user's unread rows and avoids one RPC call per notification.
create or replace function private.chat_mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id bigint;
  v_count integer;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then
    raise exception 'UNAUTHORIZED' using errcode = '42501';
  end if;

  update public.chat_inbox_notifications
     set read_at = coalesce(read_at, now())
   where user_id = v_user_id
     and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.chat_mark_all_notifications_read()
returns integer
language sql
security invoker
set search_path = ''
as $$
  select private.chat_mark_all_notifications_read();
$$;
revoke all on function private.chat_mark_all_notifications_read() from public, anon, authenticated;
revoke all on function public.chat_mark_all_notifications_read() from public, anon;
grant execute on function public.chat_mark_all_notifications_read() to authenticated;
