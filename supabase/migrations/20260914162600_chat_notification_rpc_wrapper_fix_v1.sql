-- Correct the public notification RPC wrapper volatility.
-- The wrapper delegates to a state-changing private SECURITY DEFINER function.

create or replace function public.chat_mark_notification_read(p_notification_id bigint)
returns public.chat_inbox_notifications
language sql
security invoker
set search_path = ''
volatile
as $$
  select private.chat_mark_notification_read($1);
$$;

revoke execute on function public.chat_mark_notification_read(bigint) from public, anon;
grant execute on function public.chat_mark_notification_read(bigint) to authenticated;
