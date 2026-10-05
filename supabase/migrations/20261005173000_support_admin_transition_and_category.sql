create or replace function public.chat_admin_transition_conversation(
  p_conversation_id bigint,
  p_next_status text,
  p_actor_user_id bigint
)
returns public.chat_conversations
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_actor_role text;
  v_site_id bigint;
  v_conversation public.chat_conversations;
  v_old_status text;
  v_auto_close integer;
begin
  select u.platform_role into v_actor_role
  from public.users u
  where u.id=p_actor_user_id
    and u.account_status='active'
    and exists (
      select 1 from private.platform_capability_policies p
      where p.platform_role=u.platform_role
        and p.capability='manageSupportChat'
        and p.is_allowed=true
    );
  if v_actor_role is null then raise exception 'FORBIDDEN'; end if;

  select * into v_conversation
  from public.chat_conversations
  where id=p_conversation_id
    and conversation_type='support';
  if not found then raise exception 'NOT_FOUND'; end if;

  if not (
    (v_conversation.status='SUPPORT_PENDING' and p_next_status='SUPPORT_ACTIVE') or
    (v_conversation.status='SUPPORT_ACTIVE' and p_next_status in ('WAITING_USER','RESOLVED','CLOSED')) or
    (v_conversation.status='WAITING_USER' and p_next_status in ('SUPPORT_ACTIVE','RESOLVED','CLOSED')) or
    (v_conversation.status='RESOLVED' and p_next_status in ('CLOSED','SUPPORT_ACTIVE')) or
    (v_conversation.status='CLOSED' and p_next_status='SUPPORT_ACTIVE')
  ) then
    raise exception 'INVALID_STATUS_TRANSITION';
  end if;

  select min(cas.site_id) into v_site_id
  from public.company_account_sites cas
  where cas.tenant_id=v_conversation.tenant_id;
  if v_site_id is null then raise exception 'SITE_NOT_FOUND_FOR_TENANT'; end if;

  v_old_status:=v_conversation.status;
  select auto_close_after_minutes into v_auto_close
  from public.chat_support_settings
  where id=true;

  update public.chat_conversations
  set status=p_next_status,
      resolved_at=case
        when p_next_status='RESOLVED' and resolved_at is null then now()
        when p_next_status='SUPPORT_ACTIVE' then null
        else resolved_at
      end,
      closed_at=case
        when p_next_status='CLOSED' then coalesce(closed_at,now())
        when p_next_status<>'CLOSED' then null
        else closed_at
      end,
      auto_close_at=case
        when p_next_status='RESOLVED' then now() + (coalesce(v_auto_close,2880) * interval '1 minute')
        when p_next_status in ('CLOSED','SUPPORT_ACTIVE') then null
        else auto_close_at
      end,
      closed_by_user_id=case
        when p_next_status='CLOSED' then p_actor_user_id
        when p_next_status<>'CLOSED' then null
        else closed_by_user_id
      end,
      close_reason=case
        when p_next_status='CLOSED' then coalesce(close_reason,'support_resolved')
        when p_next_status<>'CLOSED' then null
        else close_reason
      end,
      reopened_at=case
        when p_next_status='SUPPORT_ACTIVE' and v_old_status in ('RESOLVED','CLOSED') then now()
        else reopened_at
      end,
      updated_at=now()
  where id=p_conversation_id
  returning * into v_conversation;

  if p_next_status in ('SUPPORT_ACTIVE','WAITING_USER') then
    perform private.chat_apply_sla(p_conversation_id);
  end if;

  perform private.chat_log_ticket_event(
    p_conversation_id,
    case
      when p_next_status='RESOLVED' then 'resolved'
      when p_next_status='CLOSED' then 'closed'
      when p_next_status='SUPPORT_ACTIVE' and v_old_status in ('RESOLVED','CLOSED') then 'reopened'
      else 'status_changed'
    end,
    jsonb_build_object('status',p_next_status),
    v_old_status,p_next_status,null,null,p_actor_user_id
  );

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  )
  values(
    v_conversation.tenant_id,v_site_id,p_actor_user_id,v_actor_role,
    'chat_conversation',v_conversation.id::text,'status_change',
    jsonb_build_object('status',v_old_status),
    jsonb_build_object('status',p_next_status),
    jsonb_build_object('source','powerhub_support_center')
  );

  return v_conversation;
end;
$function$;

create or replace function public.chat_admin_set_conversation_category(
  p_conversation_id bigint,
  p_category_code text,
  p_actor_user_id bigint
)
returns public.chat_conversations
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_actor_role text;
  v_site_id bigint;
  v_conversation public.chat_conversations;
  v_category text;
  v_old_category text;
begin
  select u.platform_role into v_actor_role
  from public.users u
  where u.id=p_actor_user_id
    and u.account_status='active'
    and exists (
      select 1 from private.platform_capability_policies p
      where p.platform_role=u.platform_role
        and p.capability='manageSupportChat'
        and p.is_allowed=true
    );
  if v_actor_role is null then raise exception 'FORBIDDEN'; end if;

  select * into v_conversation from public.chat_conversations
  where id=p_conversation_id and conversation_type='support';
  if not found then raise exception 'NOT_FOUND'; end if;

  select code into v_category
  from public.chat_support_categories
  where code=coalesce(nullif(btrim(p_category_code),''),'other')
    and is_active=true
  limit 1;
  if v_category is null then raise exception 'INVALID_CATEGORY'; end if;

  select min(cas.site_id) into v_site_id
  from public.company_account_sites cas
  where cas.tenant_id=v_conversation.tenant_id;
  if v_site_id is null then raise exception 'SITE_NOT_FOUND_FOR_TENANT'; end if;

  v_old_category:=v_conversation.category_code;

  update public.chat_conversations
  set category_code=v_category,updated_at=now()
  where id=p_conversation_id
  returning * into v_conversation;

  perform private.chat_apply_sla(p_conversation_id);
  perform private.chat_log_ticket_event(
    p_conversation_id,'category_changed',
    jsonb_build_object('category_code',v_category),
    v_conversation.status,v_conversation.status,null,null,p_actor_user_id
  );

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data,metadata
  )
  values(
    v_conversation.tenant_id,v_site_id,p_actor_user_id,v_actor_role,
    'chat_conversation',v_conversation.id::text,'category_change',
    jsonb_build_object('category_code',v_old_category),
    jsonb_build_object('category_code',v_category),
    jsonb_build_object('source','powerhub_support_center')
  );

  return v_conversation;
end;
$function$;

revoke all on function public.chat_admin_transition_conversation(bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.chat_admin_transition_conversation(bigint,text,bigint) to service_role;

revoke all on function public.chat_admin_set_conversation_category(bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.chat_admin_set_conversation_category(bigint,text,bigint) to service_role;
