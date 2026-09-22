-- PowerHub Chat / Helpdesk ticket timeline.
-- Read-only, platform-support-scoped projection over the immutable ticket event log.

create or replace function private.chat_ticket_timeline(p_conversation_id bigint)
returns table(
  id bigint,
  event_type text,
  actor_user_id bigint,
  actor_name text,
  from_status text,
  to_status text,
  from_priority text,
  to_priority text,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path=''
stable
as $$
begin
  if private.chat_current_user_id() is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if not private.powerhub_has_platform_capability('manageSupportChat') then
    raise exception 'FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.chat_conversations
    where id = p_conversation_id
      and conversation_type = 'support'
  ) then
    raise exception 'NOT_FOUND';
  end if;

  return query
  select
    e.id,
    e.event_type,
    e.actor_user_id,
    u.name,
    e.from_status,
    e.to_status,
    e.from_priority,
    e.to_priority,
    e.metadata,
    e.created_at
  from public.chat_ticket_events e
  left join public.users u on u.id = e.actor_user_id
  where e.conversation_id = p_conversation_id
  order by e.created_at asc, e.id asc;
end;
$$;

revoke all on function private.chat_ticket_timeline(bigint) from public, anon, authenticated;

create or replace function public.chat_ticket_timeline(p_conversation_id bigint)
returns table(
  id bigint,
  event_type text,
  actor_user_id bigint,
  actor_name text,
  from_status text,
  to_status text,
  from_priority text,
  to_priority text,
  metadata jsonb,
  created_at timestamptz
)
language sql
security invoker
set search_path=''
as $fn$
  select * from private.chat_ticket_timeline($1);
$fn$;

revoke execute on function public.chat_ticket_timeline(bigint) from public, anon;
grant execute on function public.chat_ticket_timeline(bigint) to authenticated;
