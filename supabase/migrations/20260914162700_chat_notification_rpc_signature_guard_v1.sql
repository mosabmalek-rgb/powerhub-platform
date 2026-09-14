-- Regression assertions for the notification RPC security model.
-- This migration is intentionally non-invasive and documents expected grants.

-- Public wrapper: authenticated only.
revoke execute on function public.chat_mark_notification_read(bigint) from public, anon;
grant execute on function public.chat_mark_notification_read(bigint) to authenticated;

-- Private implementation: not callable by browser roles.
revoke execute on function private.chat_mark_notification_read(bigint) from public, anon, authenticated;
