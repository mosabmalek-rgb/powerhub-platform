-- Enable user-scoped Realtime delivery without polling or exposing other users' rows.
-- The RPCs remain the normal read path; SELECT is granted only so Realtime can authorize
-- postgres_changes subscriptions through RLS.
drop policy if exists powerhub_user_notifications_select_own on public.powerhub_user_notifications;
create policy powerhub_user_notifications_select_own
  on public.powerhub_user_notifications
  for select to authenticated
  using (powerhub_user_notifications.user_id = powerhub_private.current_user_id());
grant select on public.powerhub_user_notifications to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'powerhub_user_notifications'
     ) then
    alter publication supabase_realtime add table public.powerhub_user_notifications;
  end if;
end
$$;
