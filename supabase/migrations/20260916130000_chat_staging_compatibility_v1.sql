-- PowerHub Smart Support Chat v1 — runtime compatibility hardening.
--
-- This migration codifies the compatibility fixes validated in Staging:
-- 1) authenticated callers need USAGE on private because public SQL wrappers
--    are SECURITY INVOKER and delegate to reviewed private implementations.
-- 2) Only the reviewed chat implementation functions are executable by
--    authenticated; low-level helpers, rate-limit functions and trigger
--    functions remain inaccessible directly.
-- 3) Realtime trigger functions use the current Supabase
--    realtime.broadcast_changes(record, record) signature.
--
-- No Production data is touched by this source migration. It must be applied
-- through the normal migration pipeline after Staging/CI validation.

revoke all on schema private from anon, authenticated;
grant usage on schema private to authenticated;

-- Public chat wrappers are SECURITY INVOKER and therefore need EXECUTE on the
-- private implementation they delegate to. Each implementation still derives
-- actor identity from auth.uid() and performs its own authorization checks.
revoke all on function private.chat_assign_support(bigint, bigint) from public, anon, authenticated;
revoke all on function private.chat_create_conversation(bigint, text, text, text) from public, anon, authenticated;
revoke all on function private.chat_release_support(bigint) from public, anon, authenticated;
revoke all on function private.chat_send_message(bigint, text, uuid, bigint) from public, anon, authenticated;
revoke all on function private.chat_support_users() from public, anon, authenticated;
revoke all on function private.chat_transition_conversation(bigint, text) from public, anon, authenticated;
revoke all on function private.chat_mark_notification_read(bigint) from public, anon, authenticated;

grant execute on function
  private.chat_assign_support(bigint, bigint),
  private.chat_create_conversation(bigint, text, text, text),
  private.chat_release_support(bigint),
  private.chat_send_message(bigint, text, uuid, bigint),
  private.chat_support_users(),
  private.chat_transition_conversation(bigint, text),
  private.chat_mark_notification_read(bigint)
to authenticated;

-- Keep receipt/read implementation helpers private. Their public wrappers
-- should be converted to SECURITY DEFINER in a separate compatibility-safe
-- change before exposing them through authenticated SQL invocation.
revoke all on function private.chat_mark_delivered(bigint) from public, anon, authenticated;
revoke all on function private.chat_mark_read(bigint) from public, anon, authenticated;
revoke all on function private.chat_mark_read_up_to(bigint, bigint) from public, anon, authenticated;
revoke all on function private.chat_receipts_for_message(bigint) from public, anon, authenticated;

-- Realtime trigger compatibility: Supabase currently exposes the record-based
-- broadcast_changes signature. Trigger functions must not be directly callable
-- by browser roles.
create or replace function private.chat_broadcast_message_event()
returns trigger
language plpgsql
security definer
set search_path = ''
volatile
as $$
begin
  perform realtime.broadcast_changes(
    'chat:conversation:' || new.conversation_id::text,
    'chat_message',
    'INSERT',
    'chat_messages',
    'public',
    new,
    old,
    'ROW'
  );
  return new;
end;
$$;

create or replace function private.chat_broadcast_receipt_event()
returns trigger
language plpgsql
security definer
set search_path = ''
volatile
as $$
begin
  perform realtime.broadcast_changes(
    'chat:conversation:' || new.conversation_id::text,
    'chat_receipt',
    'UPDATE',
    'chat_message_receipts',
    'public',
    new,
    old,
    'ROW'
  );
  return new;
end;
$$;

create or replace function private.chat_broadcast_notification_event()
returns trigger
language plpgsql
security definer
set search_path = ''
volatile
as $$
begin
  perform realtime.broadcast_changes(
    'chat:user:' || new.user_id::text,
    'chat_notification',
    'INSERT',
    'chat_inbox_notifications',
    'public',
    new,
    old,
    'ROW'
  );
  return new;
end;
$$;

revoke all on function private.chat_broadcast_message_event() from public, anon, authenticated;
revoke all on function private.chat_broadcast_receipt_event() from public, anon, authenticated;
revoke all on function private.chat_broadcast_notification_event() from public, anon, authenticated;
