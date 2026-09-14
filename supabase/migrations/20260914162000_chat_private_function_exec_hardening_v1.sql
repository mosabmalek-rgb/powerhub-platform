-- Smart Support Chat v1 — private function EXECUTE hardening.
-- SECURITY: PostgreSQL grants EXECUTE to PUBLIC on new functions by default.
-- Private chat helpers must not be directly callable by arbitrary database roles.
-- Keep only the minimum authenticated access required by the public resolver wrapper.

-- Platform resolver: authenticated calls the public wrapper, which delegates here.
revoke all on function private.powerhub_has_platform_capability(text) from public;
grant execute on function private.powerhub_has_platform_capability(text) to authenticated;

-- Chat helpers are internal SECURITY DEFINER implementation functions.
-- Browser roles must reach them only through reviewed public wrapper functions.
revoke all on function private.chat_current_user_id() from public, anon, authenticated;
revoke all on function private.chat_can_access_conversation(bigint) from public, anon, authenticated;
revoke all on function private.chat_create_conversation(bigint, text, text, text) from public, anon, authenticated;
revoke all on function private.chat_send_message(bigint, text, uuid, bigint) from public, anon, authenticated;
revoke all on function private.chat_transition_conversation(bigint, text) from public, anon, authenticated;
revoke all on function private.chat_mark_delivered(bigint) from public, anon, authenticated;
revoke all on function private.chat_mark_read(bigint) from public, anon, authenticated;
revoke all on function private.chat_mark_read_up_to(bigint, bigint) from public, anon, authenticated;
revoke all on function private.chat_support_user_ids() from public, anon, authenticated;
revoke all on function private.chat_create_inbox_notification_for_message() from public, anon, authenticated;
revoke all on function private.chat_broadcast_message_event() from public, anon, authenticated;
revoke all on function private.chat_broadcast_receipt_event() from public, anon, authenticated;
revoke all on function private.chat_broadcast_notification_event() from public, anon, authenticated;
