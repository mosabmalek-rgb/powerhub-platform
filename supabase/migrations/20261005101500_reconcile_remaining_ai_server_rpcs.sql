-- Reconcile remaining AI server RPCs with the established ACL-only boundary.
-- These functions remain SECURITY DEFINER/search_path='' and are executable only by service_role.

create or replace function public.chat_ai_append_assistant_message(p_conversation_id bigint, p_body text, p_client_message_id uuid, p_metadata jsonb default '{}'::jsonb)
returns public.chat_messages
language plpgsql security definer set search_path=''
as $function$
declare
  v_conversation public.chat_conversations;
  v_existing public.chat_messages;
  v_message public.chat_messages;
begin
  if nullif(btrim(p_body),'') is null then raise exception 'INVALID_BODY'; end if;
  if length(p_body)>12000 then raise exception 'BODY_TOO_LONG'; end if;
  if p_client_message_id is null then raise exception 'CLIENT_MESSAGE_ID_REQUIRED'; end if;

  select * into v_conversation
  from public.chat_conversations
  where id=p_conversation_id and conversation_type='assistant';
  if not found then raise exception 'NOT_FOUND'; end if;

  select * into v_existing
  from public.chat_messages
  where conversation_id=p_conversation_id and client_message_id=p_client_message_id;
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
  exception when unique_violation then
    select * into v_existing
    from public.chat_messages
    where conversation_id=p_conversation_id and client_message_id=p_client_message_id;
    if not found or v_existing.sender_type <> 'assistant' then raise; end if;
    return v_existing;
  end;

  update public.chat_conversations
  set last_message_at=v_message.created_at,updated_at=now()
  where id=v_conversation.id;
  return v_message;
end;
$function$;

create or replace function public.chat_ai_get_account_context(p_tenant_id bigint, p_actor_user_id bigint)
returns jsonb
language plpgsql stable security definer set search_path=''
as $function$
declare
  v_subscription jsonb;
  v_tenant jsonb;
begin
  if not exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id=p_tenant_id and tm.user_id=p_actor_user_id
      and tm.is_active=true and tm.membership_status='active'
      and (tm.expires_at is null or tm.expires_at>now())
  ) then raise exception 'FORBIDDEN'; end if;

  select jsonb_build_object(
    'status',s.status,'package_code',s.package_code,'billing_cycle',s.billing_cycle,
    'started_at',s.started_at,'ends_at',s.ends_at,'auto_renew',s.auto_renew,
    'trial_duration_days',s.trial_duration_days
  ) into v_subscription
  from public.tenant_subscriptions s
  where s.tenant_id=p_tenant_id
  order by s.created_at desc limit 1;

  select jsonb_build_object('tenant_id',t.id,'tenant_name',t.name,'tenant_status',t.status)
  into v_tenant from public.tenants t where t.id=p_tenant_id;

  return jsonb_build_object('tenant',coalesce(v_tenant,'{}'::jsonb),'subscription',coalesce(v_subscription,'{}'::jsonb));
end;
$function$;

create or replace function public.chat_ai_handoff(
  p_conversation_id bigint,p_user_message_id bigint,p_ai_message_id bigint,p_actor_user_id bigint,
  p_trigger text,p_reason text,p_summary text,p_category text default 'other',p_priority text default 'normal',
  p_current_page text default null
)
returns public.chat_bot_handoffs
language plpgsql security definer set search_path=''
as $function$
declare
  v_conversation public.chat_conversations;
  v_existing public.chat_bot_handoffs;
  v_handoff public.chat_bot_handoffs;
  v_ticket text;
  v_support_user bigint;
begin
  select * into v_conversation from public.chat_conversations
  where id=p_conversation_id and conversation_type='assistant';
  if not found then raise exception 'NOT_FOUND'; end if;

  if not exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id=v_conversation.tenant_id and tm.user_id=p_actor_user_id
      and tm.is_active=true and tm.membership_status='active'
      and (tm.expires_at is null or tm.expires_at>now())
  ) then raise exception 'FORBIDDEN'; end if;

  if p_user_message_id is not null and not exists (
    select 1 from public.chat_messages
    where id=p_user_message_id and conversation_id=p_conversation_id
      and sender_type='human' and sender_user_id=p_actor_user_id
  ) then raise exception 'INVALID_USER_MESSAGE'; end if;

  if p_ai_message_id is not null and not exists (
    select 1 from public.chat_messages
    where id=p_ai_message_id and conversation_id=p_conversation_id and sender_type='assistant'
  ) then raise exception 'INVALID_AI_MESSAGE'; end if;

  if p_trigger not in ('unknown','insufficient_knowledge','sensitive','user_requested','repeated_failure') then
    raise exception 'INVALID_HANDOFF_TRIGGER';
  end if;
  if p_priority not in ('low','normal','high','urgent') then raise exception 'INVALID_PRIORITY'; end if;

  select * into v_existing from public.chat_bot_handoffs
  where conversation_id=p_conversation_id and user_message_id=p_user_message_id limit 1;
  if found then return v_existing; end if;

  v_ticket:=private.chat_support_ticket_number();
  begin
    insert into public.chat_bot_handoffs(
      conversation_id,tenant_id,trigger,reason,user_message_id,ai_message_id,
      summary,category,priority,current_page,context_snapshot
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
  exception when unique_violation then
    select * into v_existing from public.chat_bot_handoffs
    where conversation_id=p_conversation_id and user_message_id=p_user_message_id limit 1;
    if found then return v_existing; end if;
    raise;
  end;

  update public.chat_conversations
  set conversation_type='support',status='SUPPORT_PENDING',
      ticket_number=coalesce(ticket_number,v_ticket),
      category_code=coalesce(category_code,coalesce(nullif(btrim(p_category),''),'other')),
      source='assistant',
      last_customer_message_at=coalesce(last_customer_message_at,last_message_at,created_at),
      priority=p_priority,updated_at=now()
  where id=p_conversation_id;

  insert into public.chat_ticket_events(
    conversation_id,tenant_id,actor_user_id,event_type,from_status,to_status,
    from_priority,to_priority,metadata
  )
  values(
    p_conversation_id,v_conversation.tenant_id,p_actor_user_id,'status_changed',
    v_conversation.status,'SUPPORT_PENDING',v_conversation.priority,p_priority,
    jsonb_build_object('trigger',p_trigger,'reason',left(coalesce(p_reason,''),500),'handoff_id',v_handoff.id)
  );

  for v_support_user in select id from private.chat_support_user_ids() loop
    insert into public.chat_inbox_notifications(
      user_id,tenant_id,conversation_id,message_id,notification_type,title,body
    )
    values(
      v_support_user,v_conversation.tenant_id,p_conversation_id,p_ai_message_id,
      'support_update','طلب دعم جديد من مساعد PowerHub',
      coalesce(v_ticket,'تذكرة دعم') || ' — ' || left(coalesce(p_reason,'تحويل تلقائي للدعم'),180)
    )
    on conflict do nothing;
  end loop;

  return v_handoff;
end;
$function$;

create or replace function public.chat_ai_record_run(
  p_request_id uuid,p_conversation_id bigint,p_tenant_id bigint,p_user_id bigint,
  p_question_preview text,p_question_hash text,p_decision text,p_model text,
  p_top_retrieval_score real,p_retrieved_article_ids bigint[],p_handoff_id bigint,p_latency_ms integer,
  p_error_code text default null
)
returns void
language plpgsql security definer set search_path=''
as $function$
begin
  insert into private.chat_ai_runs(
    request_id,conversation_id,tenant_id,user_id,question,question_hash,question_preview,decision,model,
    top_retrieval_score,retrieved_article_ids,handoff_id,latency_ms,error_code
  )
  values(
    p_request_id,p_conversation_id,p_tenant_id,p_user_id,
    left(coalesce(p_question_preview,''),160),left(coalesce(p_question_hash,''),128),
    left(coalesce(p_question_preview,''),600),p_decision,left(coalesce(p_model,''),120),
    p_top_retrieval_score,coalesce(p_retrieved_article_ids,'{}'),p_handoff_id,
    greatest(0,coalesce(p_latency_ms,0)),left(coalesce(p_error_code,''),120)
  )
  on conflict(request_id) do nothing;
end;
$function$;

revoke all on function public.chat_ai_append_assistant_message(bigint,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.chat_ai_append_assistant_message(bigint,text,uuid,jsonb) to service_role;

revoke all on function public.chat_ai_get_account_context(bigint,bigint) from public,anon,authenticated;
grant execute on function public.chat_ai_get_account_context(bigint,bigint) to service_role;

revoke all on function public.chat_ai_handoff(bigint,bigint,bigint,bigint,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.chat_ai_handoff(bigint,bigint,bigint,bigint,text,text,text,text,text,text) to service_role;

revoke all on function public.chat_ai_record_run(uuid,bigint,bigint,bigint,text,text,text,text,real,bigint[],bigint,integer,text) from public,anon,authenticated;
grant execute on function public.chat_ai_record_run(uuid,bigint,bigint,bigint,text,text,text,text,real,bigint[],bigint,integer,text) to service_role;
