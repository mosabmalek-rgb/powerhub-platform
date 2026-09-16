-- Follow-up hardening for receipts/notifications.
-- Keeps support recipient resolution separate from the current sender identity.
create or replace function private.chat_create_inbox_notification_for_message()
returns trigger language plpgsql security definer set search_path='' volatile
as $$
declare v_recipient bigint;
begin
  if new.sender_user_id is null then return new; end if;
  for v_recipient in
    select cp.user_id
    from public.chat_participants cp
    where cp.conversation_id=new.conversation_id
      and cp.user_id<>new.sender_user_id
      and cp.left_at is null
    union
    select s
    from private.chat_support_user_ids() s
  loop
    if v_recipient is not null and v_recipient <> new.sender_user_id then
      insert into public.chat_inbox_notifications(
        user_id, tenant_id, conversation_id, message_id, notification_type, title, body
      )
      values(
        v_recipient,
        new.tenant_id,
        new.conversation_id,
        new.id,
        'chat_message',
        'رسالة جديدة في PowerHub',
        left(coalesce(new.body,'لديك رسالة جديدة في الدردشة.'),180)
      )
      on conflict do nothing;
    end if;
  end loop;
  return new;
end;
$$;