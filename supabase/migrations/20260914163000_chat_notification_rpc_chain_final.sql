-- Final notification RPC authorization state.
-- Public API: authenticated + SECURITY INVOKER + VOLATILE.
-- Private implementation: SECURITY DEFINER with browser EXECUTE revoked.

create or replace function private.chat_mark_notification_read(p_notification_id bigint)
returns public.chat_inbox_notifications
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_user_id bigint;
  v_row public.chat_inbox_notifications;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;

  update public.chat_inbox_notifications
  set read_at = coalesce(read_at, now())
  where id = p_notification_id
    and user_id = v_user_id
  returning * into v_row;

  if not found then raise exception 'NOT_FOUND'; end if;
  return v_row;
end;
$$;

revoke all on function private.chat_mark_notification_read(bigint) from public, anon, authenticated;

create or replace function public.chat_mark_notification_read(p_notification_id bigint)
returns public.chat_inbox_notifications
language sql
security invoker
set search_path = ''
volatile
as $$ select private.chat_mark_notification_read($1); $$;

revoke execute on function public.chat_mark_notification_read(bigint) from public, anon;
grant execute on function public.chat_mark_notification_read(bigint) to authenticated;
