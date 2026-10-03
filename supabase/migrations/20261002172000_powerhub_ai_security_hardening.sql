-- AI security hardening:
-- * assistant writes and handoffs are server-only
-- * retries are idempotent under concurrency
-- * AI requests are rate-limited per authenticated user
-- * AI run telemetry is server-only and stores only a sanitized preview/hash
-- * the LLM never receives privileged mutation tools.

alter table private.chat_ai_runs
  add column if not exists request_id uuid,
  add column if not exists question_hash text,
  add column if not exists question_preview text;

create unique index if not exists chat_ai_runs_request_id_key
  on private.chat_ai_runs(request_id)
  where request_id is not null;

create unique index if not exists chat_bot_handoffs_conversation_user_message_key
  on public.chat_bot_handoffs(conversation_id,user_message_id)
  where user_message_id is not null;

create unique index if not exists chat_messages_conversation_client_message_key
  on public.chat_messages(conversation_id,client_message_id)
  where client_message_id is not null;

create table if not exists private.chat_ai_rate_limit_buckets (
  user_id bigint primary key references public.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  requests_count integer not null default 0 check (requests_count >= 0),
  updated_at timestamptz not null default now()
);

-- This is intentionally exposed as a tiny authenticated-only gate.
-- The function uses auth.uid(), never a caller-supplied user id.
create or replace function public.chat_ai_rate_limit(
  p_limit integer default 12,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path=''
volatile
as $$
declare
  v_uid uuid := (select auth.uid());
  v_user_id bigint;
  v_now timestamptz := now();
  v_allowed boolean := false;
begin
  if v_uid is null then raise exception 'UNAUTHORIZED'; end if;
  if p_limit < 1 or p_limit > 60 or p_window_seconds < 10 or p_window_seconds > 3600 then
    raise exception 'INVALID_RATE_LIMIT_POLICY';
  end if;

  select id into v_user_id
  from public.users
  where auth_user_id=v_uid;

  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;

  insert into private.chat_ai_rate_limit_buckets(user_id,window_started_at,requests_count,updated_at)
  values(v_user_id,v_now,1,v_now)
  on conflict(user_id) do update
  set
    window_started_at=case
      when private.chat_ai_rate_limit_buckets.window_started_at + make_interval(secs => p_window_seconds) <= v_now
        then v_now
      else private.chat_ai_rate_limit_buckets.window_started_at
    end,
    requests_count=case
      when private.chat_ai_rate_limit_buckets.window_started_at + make_interval(secs => p_window_seconds) <= v_now
        then 1
      else private.chat_ai_rate_limit_buckets.requests_count + 1
    end,
    updated_at=v_now;

  select
    b.requests_count <= p_limit
    into v_allowed
  from private.chat_ai_rate_limit_buckets b
  where b.user_id=v_user_id;

  if not v_allowed then
    update private.chat_ai_rate_limit_buckets
    set requests_count=least(requests_count,p_limit + 1000000)
    where user_id=v_user_id;
  end if;

  return v_allowed;
end;
$$;

revoke all on function public.chat_ai_rate_limit(integer,integer) from public, anon;
grant execute on function public.chat_ai_rate_limit(integer,integer) to authenticated;

-- Internal-only assistant message write. A browser session cannot execute it.
create or replace function public.chat_ai_append_assistant_message(
  p_conversation_id bigint,
  p_body text,
  p_client_message_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns public.chat_messages
language plpgsql
security definer
set search_path=''
volatile
as $$
declare
  v_conversation public.chat_conversations;
  v_existing public.chat_messages;
  v_message public.chat_messages;
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' then
    raise exception 'INTERNAL_ONLY';
  end if;

  if nullif(btrim(p_body),'') is null then raise exception 'INVALID_BODY'; end if;
  if length(p_body)>12000 then raise exception 'BODY_TOO_LONG'; end if;
  if p_client_message_id is null then raise exception 'CLIENT_MESSAGE_ID_REQUIRED'; end if;

  select * into v_conversation
  from public.chat_conversations
  where id=p_conversation_id
    and conversation_type='assistant';

  if not found then raise exception 'NOT_FOUND'; end if;

  select * into v_existing
  from public.chat_messages
  where conversation_id=p_conversation_id
    and client_message_id=p_client_message_id;

  if found then
    if v_existing.sender_type <> 'assistant' then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return v_existing;
  end if;

  begin
    insert into public.chat_messages(
      conversation_id,tenant_id,sender_user_id,sender_type,message_type,visibility,body,client_message_id,metadata
    )
    values(
      v_conversation.id,v_conversation.tenant_id,null,'assistant','text','public',btrim(p_body),p_client_message_id,coalesce(p_metadata,'{}'::jsonb)
    )
    returning * into v_message;
  exception
    when unique_violation then
      select * into v_existing
      from public.chat_messages
      where conversation_id=p_conversation_id
        and client_message_id=p_client_message_id;
      if not found or v_existing.sender_type <> 'assistant' then raise; end if;
      return v_existing;
  end;

  update public.chat_conversations
  set last_message_at=v_message.created_at,
      updated_at=now()
  where id=v_conversation.id;

  return v_message;
end;
$$;

revoke all on function public.chat_ai_append_assistant_message(bigint,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.chat_ai_append_assistant_message(bigint,text,uuid,jsonb) to service_role;

-- Internal-only handoff. The application server performs the authorization check
-- before calling it; the database still verifies the user/message/conversation relationship.
create or replace function public.chat_ai_handoff(
  p_conversation_id bigint,
  p_user_message_id bigint,
  p_ai_message_id bigint,
  p_actor_user_id bigint,
  p_trigger text,
  p_reason text,
  p_summary text,
  p_category text default 'other',
  p_priority text default 'normal',
  p_current_page text default null
)
returns public.chat_bot_handoffs
language plpgsql
security definer
set search_path=''
volatile
as $$
declare
  v_conversation public.chat_conversations;
  v_user_message public.chat_messages;
  v_existing public.chat_bot_handoffs;
  v_handoff public.chat_bot_handoffs;
  v_ticket text;
  v_support_user bigint;
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' then
    raise exception 'INTERNAL_ONLY';
  end if;

  select * into v_conversation
  from public.chat_conversations
  where id=p_conversation_id
    and conversation_type='assistant';

  if not found then raise exception 'NOT_FOUND'; end if;

  if p_actor_user_id is null then raise exception 'ACTOR_REQUIRED'; end if;

  if not exists (
    select 1
    from public.tenant_members tm
    where tm.tenant_id=v_conversation.tenant_id
      and tm.user_id=p_actor_user_id
      and tm.is_active=true
      and tm.membership_status='active'
      and (tm.expires_at is null or tm.expires_at>now())
  ) then
    raise exception 'FORBIDDEN';
  end if;

  if p_user_message_id is not null then
    select * into v_user_message
    from public.chat_messages
    where id=p_user_message_id
      and conversation_id=p_conversation_id
      and sender_type='human'
      and sender_user_id=p_actor_user_id;

    if not found then raise exception 'INVALID_USER_MESSAGE'; end if;
  end if;

  if p_ai_message_id is not null and not exists (
    select 1 from public.chat_messages
    where id=p_ai_message_id
      and conversation_id=p_conversation_id
      and sender_type='assistant'
  ) then
    raise exception 'INVALID_AI_MESSAGE';
  end if;

  if p_trigger not in ('unknown','insufficient_knowledge','sensitive','user_requested','repeated_failure') then
    raise exception 'INVALID_HANDOFF_TRIGGER';
  end if;

  if p_priority not in ('low','normal','high','urgent') then
    raise exception 'INVALID_PRIORITY';
  end if;

  select * into v_existing
  from public.chat_bot_handoffs
  where conversation_id=p_conversation_id
    and user_message_id=p_user_message_id
  limit 1;

  if found then return v_existing; end if;

  v_ticket := private.chat_support_ticket_number();

  begin
    insert into public.chat_bot_handoffs(
      conversation_id,tenant_id,trigger,reason,user_message_id,ai_message_id,summary,category,priority,current_page,context_snapshot
    )
    values(
      v_conversation.id,v_conversation.tenant_id,p_trigger,
      coalesce(nullif(btrim(p_reason),''),'لم يتم العثور على إجابة موثوقة.'),
      p_user_message_id,p_ai_message_id,nullif(btrim(p_summary),''),
      coalesce(nullif(btrim(p_category),''),'other'),p_priority,
      nullif(left(btrim(coalesce(p_current_page,'')),200),''),
      jsonb_build_object('ticket_number',v_ticket,'source','powerhub_ai')
    )
    returning * into v_handoff;
  exception
    when unique_violation then
      select * into v_existing
      from public.chat_bot_handoffs
      where conversation_id=p_conversation_id
        and user_message_id=p_user_message_id
      limit 1;
      if found then return v_existing; end if;
      raise;
  end;

  update public.chat_conversations
  set conversation_type='support',
      status='SUPPORT_PENDING',
      ticket_number=coalesce(ticket_number,v_ticket),
      category_code=coalesce(category_code,coalesce(nullif(btrim(p_category),''),'other')),
      source='assistant',
      last_customer_message_at=coalesce(last_customer_message_at,last_message_at,created_at),
      priority=p_priority,
      updated_at=now()
  where id=p_conversation_id;

  insert into public.chat_ticket_events(
    conversation_id,tenant_id,actor_user_id,event_type,from_status,to_status,from_priority,to_priority,metadata
  )
  values(
    p_conversation_id,v_conversation.tenant_id,p_actor_user_id,'status_changed',v_conversation.status,'SUPPORT_PENDING',
    v_conversation.priority,p_priority,jsonb_build_object('trigger',p_trigger,'reason',left(coalesce(p_reason,''),500),'handoff_id',v_handoff.id)
  );

  for v_support_user in select id from private.chat_support_user_ids() loop
    insert into public.chat_inbox_notifications(
      user_id,tenant_id,conversation_id,message_id,notification_type,title,body
    )
    values(
      v_support_user,v_conversation.tenant_id,p_conversation_id,p_ai_message_id,'support_update',
      'طلب دعم جديد من مساعد PowerHub',
      coalesce(v_ticket,'تذكرة دعم') || ' — ' || left(coalesce(p_reason,'تحويل تلقائي للدعم'),180)
    )
    on conflict do nothing;
  end loop;

  return v_handoff;
end;
$$;

revoke all on function public.chat_ai_handoff(bigint,bigint,bigint,bigint,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.chat_ai_handoff(bigint,bigint,bigint,bigint,text,text,text,text,text,text) to service_role;

create or replace function public.chat_ai_record_run(
  p_request_id uuid,
  p_conversation_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_question_preview text,
  p_question_hash text,
  p_decision text,
  p_model text,
  p_top_retrieval_score real,
  p_retrieved_article_ids bigint[],
  p_handoff_id bigint,
  p_latency_ms integer,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path=''
volatile
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' then
    raise exception 'INTERNAL_ONLY';
  end if;

  insert into private.chat_ai_runs(
    request_id,conversation_id,tenant_id,user_id,question,question_hash,question_preview,decision,model,
    top_retrieval_score,retrieved_article_ids,handoff_id,latency_ms,error_code
  )
  values(
    p_request_id,p_conversation_id,p_tenant_id,p_user_id,left(coalesce(p_question_preview,''),600),
    left(coalesce(p_question_hash,''),128),left(coalesce(p_question_preview,''),600),p_decision,p_model,
    p_top_retrieval_score,coalesce(p_retrieved_article_ids,'{}'),p_handoff_id,p_latency_ms,left(p_error_code,120)
  )
  on conflict(request_id) do nothing;
end;
$$;

revoke all on function public.chat_ai_record_run(uuid,bigint,bigint,bigint,text,text,text,text,real,bigint[],bigint,integer,text)
  from public, anon, authenticated;
grant execute on function public.chat_ai_record_run(uuid,bigint,bigint,bigint,text,text,text,text,real,bigint[],bigint,integer,text)
  to service_role;

-- Avoid surfacing raw AI request text in the support admin snapshot.
create or replace function public.chat_ai_admin_snapshot()
returns jsonb
language plpgsql
security invoker
set search_path=''
stable
as $$
declare v_user bigint;
begin
  select id into v_user from public.users where auth_user_id=(select auth.uid());
  if v_user is null then raise exception 'UNAUTHORIZED'; end if;
  if not private.powerhub_has_platform_capability('manageSupportChat') then raise exception 'FORBIDDEN'; end if;

  return jsonb_build_object(
    'settings', coalesce((select jsonb_build_object(
      'enabled',s.enabled,
      'model',s.model,
      'minRetrievalScore',s.min_retrieval_score,
      'maxArticles',s.max_articles,
      'maxHistoryMessages',s.max_history_messages,
      'handoffOnUnknown',s.handoff_on_unknown,
      'updatedAt',s.updated_at
    ) from private.chat_ai_settings s where id=true),'{}'::jsonb),
    'knowledge', jsonb_build_object(
      'total', (select count(*) from public.chat_knowledge_articles),
      'published', (select count(*) from public.chat_knowledge_articles where status='published'),
      'draft', (select count(*) from public.chat_knowledge_articles where status='draft'),
      'archived', (select count(*) from public.chat_knowledge_articles where status='archived')
    ),
    'recentFailures', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at desc)
      from (
        select decision,error_code,question_preview,top_retrieval_score,created_at
        from private.chat_ai_runs
        where decision in ('handoff','error')
        order by created_at desc
        limit 20
      ) r
    ),'[]'::jsonb)
  );
end;
$$;

revoke all on function public.chat_ai_admin_snapshot() from public, anon;
grant execute on function public.chat_ai_admin_snapshot() to authenticated;

-- The currently verified production model is GPT-5 through Vercel AI Gateway.
update private.chat_ai_settings
set model='openai/gpt-5', updated_at=now()
where id=true;
