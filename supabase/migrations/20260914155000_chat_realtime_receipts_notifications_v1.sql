-- Realtime delivery for chat messages, receipts, and in-app notifications.
-- Private topics only; authorization lives in realtime.messages RLS.

create or replace function private.chat_broadcast_message_event()
returns trigger language plpgsql security definer set search_path='' volatile
as $$
begin
  perform realtime.broadcast_changes(
    'chat:conversation:' || new.conversation_id::text,
    'chat_message', 'INSERT', 'chat_messages', 'public',
    jsonb_build_object('message_id',new.id,'conversation_id',new.conversation_id,'created_at',new.created_at),
    '{}'::jsonb
  );
  return new;
end;
$$;

drop trigger if exists chat_messages_broadcast_after_insert on public.chat_messages;
create trigger chat_messages_broadcast_after_insert after insert on public.chat_messages
for each row execute function private.chat_broadcast_message_event();

create or replace function private.chat_broadcast_receipt_event()
returns trigger language plpgsql security definer set search_path='' volatile
as $$
begin
  perform realtime.broadcast_changes(
    'chat:conversation:' || new.conversation_id::text,
    'chat_receipt', 'UPDATE', 'chat_message_receipts', 'public',
    jsonb_build_object('message_id',new.message_id,'conversation_id',new.conversation_id,'user_id',new.user_id,'delivered_at',new.delivered_at,'read_at',new.read_at),
    '{}'::jsonb
  );
  return new;
end;
$$;

drop trigger if exists chat_message_receipts_broadcast_after_change on public.chat_message_receipts;
create trigger chat_message_receipts_broadcast_after_change after insert or update on public.chat_message_receipts
for each row execute function private.chat_broadcast_receipt_event();

create or replace function private.chat_broadcast_notification_event()
returns trigger language plpgsql security definer set search_path='' volatile
as $$
begin
  perform realtime.broadcast_changes(
    'chat:user:' || new.user_id::text,
    'chat_notification', 'INSERT', 'chat_inbox_notifications', 'public',
    jsonb_build_object('notification_id',new.id,'conversation_id',new.conversation_id,'message_id',new.message_id,'created_at',new.created_at),
    '{}'::jsonb
  );
  return new;
end;
$$;

drop trigger if exists chat_inbox_notifications_broadcast_after_insert on public.chat_inbox_notifications;
create trigger chat_inbox_notifications_broadcast_after_insert after insert on public.chat_inbox_notifications
for each row execute function private.chat_broadcast_notification_event();

create policy chat_user_notification_receive
on realtime.messages for select to authenticated
using (
  extension = 'broadcast'
  and realtime.topic() ~ '^chat:user:[0-9]+$'
  and split_part(realtime.topic(), ':', 3)::bigint = powerhub_private.current_user_id()
);