-- PowerHub Chat / Helpdesk v2 security hardening.
-- Public RPCs are invoker wrappers; privileged logic remains private.

create policy chat_support_settings_select_support
on public.chat_support_settings
for select to authenticated
using (private.powerhub_has_platform_capability('manageSupportChat'));

revoke all on table public.chat_support_settings from anon, authenticated;
grant select on table public.chat_support_settings to authenticated;

create or replace function private.chat_support_queue(
  p_status text default null,
  p_priority text default null,
  p_category_code text default null,
  p_assigned_user_id bigint default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table(
  conversation_id bigint, ticket_number text, tenant_id bigint, tenant_name text, subject text,
  status text, priority text, category_code text, category_name text, assigned_user_id bigint,
  assigned_user_name text, requester_user_id bigint, requester_name text, requester_email text,
  last_message_at timestamptz, first_response_at timestamptz, first_response_due_at timestamptz,
  resolution_due_at timestamptz, resolved_at timestamptz, closed_at timestamptz, auto_close_at timestamptz,
  unread_count bigint, sla_state text, created_at timestamptz
)
language plpgsql
security definer
set search_path=''
stable
as $$
begin
  if private.chat_current_user_id() is null then raise exception 'UNAUTHORIZED'; end if;
  if not private.powerhub_has_platform_capability('manageSupportChat') then raise exception 'FORBIDDEN'; end if;
  return query
  select
    c.id,c.ticket_number,c.tenant_id,t.name,c.subject,c.status,c.priority,c.category_code,sc.name,
    c.assigned_user_id,au.name,c.created_by_user_id,ru.name,ru.email,c.last_message_at,c.first_response_at,
    c.first_response_due_at,c.resolution_due_at,c.resolved_at,c.closed_at,c.auto_close_at,
    (select count(*) from public.chat_messages m left join public.chat_participants cp
      on cp.conversation_id=c.id and cp.user_id=private.chat_current_user_id() and cp.left_at is null
      where m.conversation_id=c.id and m.visibility='public'
        and m.sender_user_id is distinct from private.chat_current_user_id()
        and (cp.last_read_at is null or m.created_at>cp.last_read_at)),
    case
      when c.status='CLOSED' then 'closed'
      when c.status='RESOLVED' then 'resolved'
      when c.first_response_at is null and c.first_response_due_at is not null and now()>c.first_response_due_at then 'first_response_breached'
      when c.resolution_due_at is not null and c.resolved_at is null and now()>c.resolution_due_at then 'resolution_breached'
      else 'on_track'
    end,
    c.created_at
  from public.chat_conversations c
  join public.tenants t on t.id=c.tenant_id
  left join public.users au on au.id=c.assigned_user_id
  left join public.users ru on ru.id=c.created_by_user_id
  left join public.chat_support_categories sc on sc.code=c.category_code
  where c.conversation_type='support'
    and (p_status is null or c.status=p_status)
    and (p_priority is null or c.priority=p_priority)
    and (p_category_code is null or c.category_code=p_category_code)
    and (p_assigned_user_id is null or c.assigned_user_id=p_assigned_user_id)
    and (nullif(btrim(p_search),'') is null
      or c.ticket_number ilike '%'||btrim(p_search)||'%'
      or coalesce(c.subject,'') ilike '%'||btrim(p_search)||'%'
      or coalesce(t.name,'') ilike '%'||btrim(p_search)||'%'
      or coalesce(ru.name,'') ilike '%'||btrim(p_search)||'%'
      or coalesce(ru.email,'') ilike '%'||btrim(p_search)||'%')
  order by
    case when c.status='SUPPORT_PENDING' then 0 when c.status='SUPPORT_ACTIVE' then 1 when c.status='WAITING_USER' then 2 when c.status='RESOLVED' then 3 else 4 end,
    case c.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    c.last_message_at desc nulls last
  limit greatest(1,least(coalesce(p_limit,50),100))
  offset greatest(0,coalesce(p_offset,0));
end;
$$;

revoke all on function private.chat_support_queue(text,text,text,bigint,text,integer,integer) from public,anon,authenticated;

create or replace function public.chat_support_queue(
  p_status text default null,p_priority text default null,p_category_code text default null,
  p_assigned_user_id bigint default null,p_search text default null,p_limit integer default 50,p_offset integer default 0
)
returns table(
  conversation_id bigint,ticket_number text,tenant_id bigint,tenant_name text,subject text,status text,priority text,
  category_code text,category_name text,assigned_user_id bigint,assigned_user_name text,requester_user_id bigint,
  requester_name text,requester_email text,last_message_at timestamptz,first_response_at timestamptz,
  first_response_due_at timestamptz,resolution_due_at timestamptz,resolved_at timestamptz,closed_at timestamptz,
  auto_close_at timestamptz,unread_count bigint,sla_state text,created_at timestamptz
)
language sql security invoker set search_path=''
as $$ select * from private.chat_support_queue($1,$2,$3,$4,$5,$6,$7); $$;

revoke execute on function public.chat_support_queue(text,text,text,bigint,text,integer,integer) from public,anon;
grant execute on function public.chat_support_queue(text,text,text,bigint,text,integer,integer) to authenticated;

create or replace function private.chat_support_metrics(p_from timestamptz,p_to timestamptz)
returns table(open_count bigint,resolved_count bigint,closed_count bigint,average_first_response_minutes numeric,
average_resolution_minutes numeric,first_response_breaches bigint,resolution_breaches bigint,average_rating numeric,
rating_count bigint,reopened_count bigint)
language plpgsql security definer set search_path='' stable
as $$
begin
  if private.chat_current_user_id() is null then raise exception 'UNAUTHORIZED'; end if;
  if not private.powerhub_has_platform_capability('manageSupportChat') then raise exception 'FORBIDDEN'; end if;
  return query
  select count(*) filter(where c.status in('SUPPORT_PENDING','SUPPORT_ACTIVE','WAITING_USER')),
    count(*) filter(where c.status='RESOLVED'),count(*) filter(where c.status='CLOSED'),
    round(avg(extract(epoch from(c.first_response_at-c.created_at))/60.0) filter(where c.first_response_at is not null),2),
    round(avg(extract(epoch from(c.resolved_at-c.created_at))/60.0) filter(where c.resolved_at is not null),2),
    count(*) filter(where c.first_response_breached_at is not null),
    count(*) filter(where c.resolution_breached_at is not null),
    round(avg(f.rating)::numeric,2),count(f.id),count(*) filter(where c.reopened_at is not null)
  from public.chat_conversations c left join public.chat_support_feedback f on f.conversation_id=c.id
  where c.conversation_type='support' and c.created_at>=coalesce(p_from,'1970-01-01'::timestamptz)
    and c.created_at<coalesce(p_to,now());
end;
$$;

revoke all on function private.chat_support_metrics(timestamptz,timestamptz) from public,anon,authenticated;

create or replace function public.chat_support_metrics(p_from timestamptz,p_to timestamptz)
returns table(open_count bigint,resolved_count bigint,closed_count bigint,average_first_response_minutes numeric,
average_resolution_minutes numeric,first_response_breaches bigint,resolution_breaches bigint,average_rating numeric,
rating_count bigint,reopened_count bigint)
language sql security invoker set search_path=''
as $$ select * from private.chat_support_metrics($1,$2); $$;

revoke execute on function public.chat_support_metrics(timestamptz,timestamptz) from public,anon;
grant execute on function public.chat_support_metrics(timestamptz,timestamptz) to authenticated;
