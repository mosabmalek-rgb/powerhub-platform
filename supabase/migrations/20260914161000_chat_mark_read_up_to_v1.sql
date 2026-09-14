-- Smart Support Chat v1: mark all received messages up to a message as read.
-- Identity always comes from auth.uid(); browser cannot choose the reader.
create or replace function private.chat_mark_read_up_to(p_conversation_id bigint, p_message_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_user_id bigint;
  v_tenant_id bigint;
  v_target_created_at timestamptz;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;

  select c.tenant_id, m.created_at into v_tenant_id, v_target_created_at
  from public.chat_conversations c
  join public.chat_messages m on m.id = p_message_id and m.conversation_id = c.id
  where c.id = p_conversation_id;
  if v_tenant_id is null then raise exception 'NOT_FOUND'; end if;

  if not exists (
    select 1
    from public.chat_participants cp
    join public.tenant_members tm on tm.tenant_id = cp.tenant_id and tm.user_id = cp.user_id
    where cp.conversation_id = p_conversation_id
      and cp.user_id = v_user_id
      and cp.left_at is null
      and tm.is_active = true
      and (tm.expires_at is null or tm.expires_at > now())
  ) and not private.powerhub_has_platform_capability('manageSupportChat') then
    raise exception 'FORBIDDEN';
  end if;

  insert into public.chat_message_receipts (tenant_id, conversation_id, message_id, user_id, delivered_at, read_at)
  select m.tenant_id, m.conversation_id, m.id, v_user_id, now(), now()
  from public.chat_messages m
  where m.conversation_id = p_conversation_id
    and m.created_at <= v_target_created_at
    and m.sender_user_id is distinct from v_user_id
  on conflict (message_id, user_id) do update
    set delivered_at = coalesce(public.chat_message_receipts.delivered_at, excluded.delivered_at),
        read_at = coalesce(public.chat_message_receipts.read_at, excluded.read_at),
        updated_at = now();

  update public.chat_participants
  set last_read_message_id = p_message_id, last_read_at = now(), updated_at = now()
  where conversation_id = p_conversation_id and user_id = v_user_id and left_at is null;

  return 1;
end;
$$;

create or replace function public.chat_mark_read_up_to(p_conversation_id bigint, p_message_id bigint)
returns bigint
language sql
security invoker
set search_path = ''
as $$ select private.chat_mark_read_up_to($1, $2); $$;

revoke execute on function public.chat_mark_read_up_to(bigint, bigint) from public, anon;
grant execute on function public.chat_mark_read_up_to(bigint, bigint) to authenticated;
