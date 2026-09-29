-- Harden authenticated chat browser wrappers.
-- The public RPC boundary remains callable by authenticated users only,
-- while the private implementation functions stay non-callable directly.
--
-- These wrappers must be SECURITY DEFINER because their private chat
-- implementations intentionally do not grant EXECUTE to browser roles.
-- The private implementations continue to derive actor identity from auth.uid()
-- and enforce tenant, participant, support-capability, and idempotency checks.

create or replace function public.chat_assign_support(
  p_conversation_id bigint,
  p_assigned_user_id bigint
)
returns public.chat_support_assignments
language sql
security definer
set search_path = ''
as $function$
  select private.chat_assign_support($1, $2);
$function$;

create or replace function public.chat_create_conversation(
  p_tenant_id bigint,
  p_conversation_type text default 'assistant',
  p_subject text default null,
  p_priority text default 'normal'
)
returns public.chat_conversations
language sql
security definer
set search_path = ''
as $function$
  select private.chat_create_conversation($1, $2, $3, $4);
$function$;

create or replace function public.chat_mark_delivered(
  p_message_id bigint
)
returns public.chat_message_receipts
language sql
security definer
set search_path = ''
as $function$
  select private.chat_mark_delivered($1);
$function$;

create or replace function public.chat_mark_notification_read(
  p_notification_id bigint
)
returns public.chat_inbox_notifications
language sql
security definer
set search_path = ''
as $function$
  select private.chat_mark_notification_read($1);
$function$;

create or replace function public.chat_mark_read(
  p_message_id bigint
)
returns public.chat_message_receipts
language sql
security definer
set search_path = ''
as $function$
  select private.chat_mark_read($1);
$function$;

create or replace function public.chat_mark_read_up_to(
  p_conversation_id bigint,
  p_message_id bigint
)
returns bigint
language sql
security definer
set search_path = ''
as $function$
  select private.chat_mark_read_up_to($1, $2);
$function$;

create or replace function public.chat_release_support(
  p_conversation_id bigint
)
returns public.chat_support_assignments
language sql
security definer
set search_path = ''
as $function$
  select private.chat_release_support($1);
$function$;

create or replace function public.chat_send_message(
  p_conversation_id bigint,
  p_body text,
  p_client_message_id uuid,
  p_reply_to_message_id bigint default null
)
returns public.chat_messages
language sql
security definer
set search_path = ''
as $function$
  select private.chat_send_message($1, $2, $3, $4);
$function$;

create or replace function public.chat_support_users()
returns table(
  id bigint,
  name text,
  email text,
  platform_role text
)
language sql
security definer
set search_path = ''
as $function$
  select * from private.chat_support_users();
$function$;

create or replace function public.chat_transition_conversation(
  p_conversation_id bigint,
  p_next_status text
)
returns public.chat_conversations
language sql
security definer
set search_path = ''
as $function$
  select private.chat_transition_conversation($1, $2);
$function$;

revoke all on function public.chat_assign_support(bigint, bigint) from public, anon;
grant execute on function public.chat_assign_support(bigint, bigint) to authenticated, service_role;

revoke all on function public.chat_create_conversation(bigint, text, text, text) from public, anon;
grant execute on function public.chat_create_conversation(bigint, text, text, text) to authenticated, service_role;

revoke all on function public.chat_mark_delivered(bigint) from public, anon;
grant execute on function public.chat_mark_delivered(bigint) to authenticated, service_role;

revoke all on function public.chat_mark_notification_read(bigint) from public, anon;
grant execute on function public.chat_mark_notification_read(bigint) to authenticated, service_role;

revoke all on function public.chat_mark_read(bigint) from public, anon;
grant execute on function public.chat_mark_read(bigint) to authenticated, service_role;

revoke all on function public.chat_mark_read_up_to(bigint, bigint) from public, anon;
grant execute on function public.chat_mark_read_up_to(bigint, bigint) to authenticated, service_role;

revoke all on function public.chat_release_support(bigint) from public, anon;
grant execute on function public.chat_release_support(bigint) to authenticated, service_role;

revoke all on function public.chat_send_message(bigint, text, uuid, bigint) from public, anon;
grant execute on function public.chat_send_message(bigint, text, uuid, bigint) to authenticated, service_role;

revoke all on function public.chat_support_users() from public, anon;
grant execute on function public.chat_support_users() to authenticated, service_role;

revoke all on function public.chat_transition_conversation(bigint, text) from public, anon;
grant execute on function public.chat_transition_conversation(bigint, text) to authenticated, service_role;
