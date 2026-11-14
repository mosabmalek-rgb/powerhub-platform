-- Narrow authorization hardening for tenant chat and Support Center RPCs.
-- Keeps the existing public RPC API and grants unchanged while aligning internal
-- mutation/read paths with the canonical active-membership and support-only scope.

DO $preflight$
DECLARE
  v_signature text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'private.chat_current_user_id()',
    'private.chat_mark_read(bigint)',
    'private.chat_mark_read_up_to(bigint,bigint)',
    'private.chat_rate_support(bigint,smallint,text)',
    'private.chat_reopen_support_conversation(bigint)',
    'private.chat_transition_conversation(bigint,text)',
    'private.chat_release_support(bigint)',
    'public.chat_receipts_for_message(bigint)',
    'public.chat_ai_rate_message(bigint,text,text)',
    'public.powerhub_notification_list(integer)',
    'public.powerhub_notification_mark_all_read()',
    'public.powerhub_notification_mark_read(bigint)',
    'public.powerhub_notification_unread_count()',
    'private.chat_can_access_conversation(bigint)',
    'private.powerhub_has_platform_capability(text)',
    'private.chat_log_ticket_event(bigint,text,jsonb,text,text,text,text,bigint)',
    'private.chat_apply_sla(bigint)',
    'auth.uid()'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'CHAT_RPC_MEMBERSHIP_SCOPE_DEPENDENCY_MISSING: %',v_signature;
    END IF;
  END LOOP;
END
$preflight$;

CREATE OR REPLACE FUNCTION private.chat_current_user_id()
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select u.id
  from public.users u
  where u.auth_user_id = (select auth.uid())
    and u.account_status = 'active'
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION private.chat_mark_read(p_message_id bigint)
 RETURNS chat_message_receipts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id bigint; v_receipt public.chat_message_receipts; v_msg public.chat_messages;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;
  select * into v_msg from public.chat_messages where id=p_message_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not private.chat_can_access_conversation(v_msg.conversation_id)
     or (v_msg.visibility='internal' and not private.powerhub_has_platform_capability('manageSupportChat')) then
    raise exception 'FORBIDDEN';
  end if;
  if v_msg.sender_user_id = v_user_id then raise exception 'INVALID_RECIPIENT'; end if;
  insert into public.chat_message_receipts(tenant_id,conversation_id,message_id,user_id,delivered_at,read_at)
  values(v_msg.tenant_id,v_msg.conversation_id,v_msg.id,v_user_id,now(),now())
  on conflict (message_id,user_id) do update set delivered_at=coalesce(public.chat_message_receipts.delivered_at,now()), read_at=coalesce(public.chat_message_receipts.read_at,now()), updated_at=now()
  returning * into v_receipt;
  update public.chat_participants set last_read_message_id=v_msg.id,last_read_at=now(),updated_at=now() where conversation_id=v_msg.conversation_id and user_id=v_user_id and left_at is null;
  return v_receipt;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chat_mark_read_up_to(p_conversation_id bigint, p_message_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id bigint;
  v_tenant_id bigint;
  v_target_created_at timestamptz;
  v_target_visibility text;
  v_count bigint;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;

  select c.tenant_id, m.created_at, m.visibility
    into v_tenant_id, v_target_created_at, v_target_visibility
  from public.chat_conversations c
  join public.chat_messages m
    on m.id = p_message_id and m.conversation_id = c.id
  where c.id = p_conversation_id;

  if v_tenant_id is null then raise exception 'NOT_FOUND'; end if;

  if not private.chat_can_access_conversation(p_conversation_id)
     or (v_target_visibility='internal' and not private.powerhub_has_platform_capability('manageSupportChat')) then
    raise exception 'FORBIDDEN';
  end if;

  insert into public.chat_message_receipts (
    tenant_id, conversation_id, message_id, user_id, delivered_at, read_at
  )
  select
    m.tenant_id,
    m.conversation_id,
    m.id,
    v_user_id,
    coalesce(r.delivered_at, now()),
    coalesce(r.read_at, now())
  from public.chat_messages m
  left join public.chat_message_receipts r
    on r.message_id = m.id and r.user_id = v_user_id
  where m.conversation_id = p_conversation_id
    and m.created_at <= v_target_created_at
    and m.sender_user_id is distinct from v_user_id
    and (m.visibility='public' or private.powerhub_has_platform_capability('manageSupportChat'))
    and r.id is null
  on conflict (message_id, user_id) do update
    set delivered_at = coalesce(public.chat_message_receipts.delivered_at, excluded.delivered_at),
        read_at = coalesce(public.chat_message_receipts.read_at, excluded.read_at),
        updated_at = now();

  update public.chat_participants
  set last_read_message_id = p_message_id,
      last_read_at = now(),
      updated_at = now()
  where conversation_id = p_conversation_id
    and user_id = v_user_id
    and left_at is null;

  select count(*) into v_count
  from public.chat_message_receipts r
  where r.conversation_id = p_conversation_id
    and r.user_id = v_user_id
    and r.read_at is not null
    and r.updated_at >= now() - interval '1 second';

  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chat_rate_support(p_conversation_id bigint, p_rating smallint, p_comment text DEFAULT NULL::text)
 RETURNS chat_support_feedback
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user bigint;
  v_conv public.chat_conversations;
  v_row public.chat_support_feedback;
begin
  v_user := private.chat_current_user_id();
  if v_user is null then raise exception 'UNAUTHORIZED'; end if;
  select * into v_conv from public.chat_conversations where id=p_conversation_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_conv.conversation_type <> 'support' then raise exception 'NOT_SUPPORT_CONVERSATION'; end if;
  if v_conv.status not in ('RESOLVED','CLOSED') then raise exception 'FEEDBACK_ONLY_AFTER_RESOLUTION'; end if;

  if not exists(
    select 1 from public.chat_participants cp
    join public.tenant_members tm on tm.tenant_id=v_conv.tenant_id and tm.user_id=cp.user_id
    where cp.conversation_id=p_conversation_id and cp.user_id=v_user and cp.left_at is null
      and tm.is_active=true and tm.membership_status='active'
      and (tm.expires_at is null or tm.expires_at>now())
  ) then raise exception 'FORBIDDEN'; end if;

  if p_rating not between 1 and 5 then raise exception 'INVALID_RATING'; end if;
  insert into public.chat_support_feedback(conversation_id,tenant_id,user_id,rating,comment)
  values(p_conversation_id,v_conv.tenant_id,v_user,p_rating,nullif(btrim(p_comment),''))
  on conflict (conversation_id,user_id) do update
    set rating=excluded.rating,comment=excluded.comment,created_at=now()
  returning * into v_row;

  perform private.chat_log_ticket_event(p_conversation_id,'customer_rated',jsonb_build_object('rating',p_rating),null,null,null,null,v_user);
  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chat_reopen_support_conversation(p_conversation_id bigint)
 RETURNS chat_conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user bigint;
  v_conversation public.chat_conversations;
  v_window integer;
  v_is_support boolean;
begin
  v_user := private.chat_current_user_id();
  if v_user is null then raise exception 'UNAUTHORIZED'; end if;
  select * into v_conversation from public.chat_conversations where id=p_conversation_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_conversation.conversation_type <> 'support' then raise exception 'NOT_SUPPORT_CONVERSATION'; end if;
  v_is_support := private.powerhub_has_platform_capability('manageSupportChat');

  if not v_is_support and not exists(
    select 1 from public.chat_participants cp
    join public.tenant_members tm on tm.tenant_id=v_conversation.tenant_id and tm.user_id=cp.user_id
    where cp.conversation_id=p_conversation_id and cp.user_id=v_user and cp.left_at is null and tm.is_active=true and tm.membership_status='active'
      and (tm.expires_at is null or tm.expires_at>now())
  ) then raise exception 'FORBIDDEN'; end if;

  select reopen_window_minutes into v_window from public.chat_support_settings where id=true;

  if coalesce(v_conversation.resolved_at,v_conversation.closed_at) is null
     or coalesce(v_conversation.resolved_at,v_conversation.closed_at) < now() - (coalesce(v_window,10080) * interval '1 minute')
  then raise exception 'REOPEN_WINDOW_EXPIRED'; end if;

  update public.chat_conversations
  set status='SUPPORT_ACTIVE',
      reopened_at=now(),
      resolved_at=null,
      closed_at=null,
      auto_close_at=null,
      closed_by_user_id=null,
      close_reason=null,
      updated_at=now()
  where id=p_conversation_id
  returning * into v_conversation;

  perform private.chat_log_ticket_event(p_conversation_id,'reopened',jsonb_build_object('reason','manual_reopen'),null,'SUPPORT_ACTIVE',null,null,v_user);
  return v_conversation;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chat_transition_conversation(p_conversation_id bigint, p_next_status text)
 RETURNS chat_conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id bigint;
  v_conversation public.chat_conversations;
  v_is_support boolean;
  v_is_participant boolean;
  v_old_status text;
  v_auto_close integer;
begin
  v_user_id := private.chat_current_user_id();
  if v_user_id is null then raise exception 'UNAUTHORIZED'; end if;

  select * into v_conversation from public.chat_conversations where id=p_conversation_id;
  if not found then raise exception 'NOT_FOUND'; end if;

  v_is_support := private.powerhub_has_platform_capability('manageSupportChat');
  if v_is_support and v_conversation.conversation_type <> 'support' then
    raise exception 'NOT_SUPPORT_CONVERSATION';
  end if;
  v_is_participant := exists(
    select 1
    from public.chat_participants cp
    join public.tenant_members tm on tm.tenant_id=v_conversation.tenant_id and tm.user_id=cp.user_id
    where cp.conversation_id=v_conversation.id and cp.user_id=v_user_id and cp.left_at is null
      and tm.is_active=true and tm.membership_status='active'
      and (tm.expires_at is null or tm.expires_at>now())
  );

  if not v_is_support and not v_is_participant then raise exception 'FORBIDDEN'; end if;

  v_old_status := v_conversation.status;

  if v_is_support then
    if not (
      (v_conversation.status='SUPPORT_PENDING' and p_next_status='SUPPORT_ACTIVE') or
      (v_conversation.status='SUPPORT_ACTIVE' and p_next_status in ('WAITING_USER','RESOLVED','CLOSED')) or
      (v_conversation.status='WAITING_USER' and p_next_status in ('SUPPORT_ACTIVE','RESOLVED','CLOSED')) or
      (v_conversation.status='RESOLVED' and p_next_status in ('CLOSED','SUPPORT_ACTIVE')) or
      (v_conversation.status='CLOSED' and p_next_status='SUPPORT_ACTIVE')
    ) then raise exception 'INVALID_STATUS_TRANSITION'; end if;
  else
    if not (
      (v_conversation.status='AI_ACTIVE' and p_next_status='SUPPORT_PENDING')
      or (v_conversation.status='WAITING_USER' and p_next_status='SUPPORT_ACTIVE')
      or (v_conversation.status='RESOLVED' and p_next_status='SUPPORT_ACTIVE')
    ) then raise exception 'INVALID_STATUS_TRANSITION'; end if;
  end if;

  select auto_close_after_minutes into v_auto_close from public.chat_support_settings where id=true;

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
        when p_next_status='CLOSED' then null
        when p_next_status='SUPPORT_ACTIVE' then null
        else auto_close_at
      end,
      closed_by_user_id=case when p_next_status='CLOSED' then v_user_id when p_next_status<>'CLOSED' then null else closed_by_user_id end,
      close_reason=case when p_next_status='CLOSED' then coalesce(close_reason,'support_resolved') when p_next_status<>'CLOSED' then null else close_reason end,
      reopened_at=case when p_next_status='SUPPORT_ACTIVE' and v_old_status in ('RESOLVED','CLOSED') then now() else reopened_at end,
      updated_at=now()
  where id=p_conversation_id
  returning * into v_conversation;

  if p_next_status in ('SUPPORT_ACTIVE','WAITING_USER') then
    perform private.chat_apply_sla(p_conversation_id);
  end if;

  perform private.chat_log_ticket_event(
    p_conversation_id,
    case when p_next_status='RESOLVED' then 'resolved' when p_next_status='CLOSED' then 'closed' when p_next_status='SUPPORT_ACTIVE' and v_old_status in ('RESOLVED','CLOSED') then 'reopened' else 'status_changed' end,
    jsonb_build_object('status',p_next_status),
    v_old_status,p_next_status,null,null,v_user_id
  );

  return v_conversation;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chat_release_support(p_conversation_id bigint)
 RETURNS chat_support_assignments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor bigint;
  v_assignment public.chat_support_assignments;
  v_conversation public.chat_conversations;
begin
  v_actor := private.chat_current_user_id();
  if v_actor is null then raise exception 'UNAUTHORIZED'; end if;
  if not private.powerhub_has_platform_capability('manageSupportChat') then raise exception 'FORBIDDEN'; end if;

  select * into v_conversation
  from public.chat_conversations
  where id=p_conversation_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_conversation.conversation_type <> 'support' then
    raise exception 'NOT_SUPPORT_CONVERSATION';
  end if;

  update public.chat_support_assignments
  set status='released',released_at=now(),updated_at=now()
  where conversation_id=p_conversation_id and status in ('pending','active')
  returning * into v_assignment;

  if not found then raise exception 'NOT_FOUND'; end if;

  update public.chat_participants
  set left_at=now(),updated_at=now()
  where conversation_id=p_conversation_id and participant_role='support' and left_at is null;

  update public.chat_conversations
  set assigned_user_id=null,
      status=case when status in ('SUPPORT_ACTIVE','WAITING_USER') then 'SUPPORT_PENDING' else status end,
      updated_at=now()
  where id=p_conversation_id
  returning * into v_conversation;

  perform private.chat_log_ticket_event(p_conversation_id,'released',jsonb_build_object('released_user_id',v_assignment.assigned_user_id),null,null,null,null,v_actor);
  return v_assignment;
end;
$function$;

CREATE OR REPLACE FUNCTION public.chat_receipts_for_message(p_message_id bigint)
 RETURNS SETOF public.chat_message_receipts
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select r.*
  from public.chat_message_receipts r
  join public.chat_messages m
    on m.id = r.message_id
  join public.chat_conversations c
    on c.id = m.conversation_id
   and c.tenant_id = m.tenant_id
  where r.message_id = p_message_id
    and (
      (m.visibility = 'public' and private.chat_can_access_conversation(c.id))
      or (
        m.visibility = 'internal'
        and c.conversation_type = 'support'
        and private.powerhub_has_platform_capability('manageSupportChat')
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.chat_ai_rate_message(p_message_id bigint, p_rating text, p_feedback_text text DEFAULT NULL::text)
 RETURNS chat_bot_feedback
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user bigint;
  v_message public.chat_messages;
  v_row public.chat_bot_feedback;
begin
  select id into v_user
  from public.users
  where auth_user_id=(select auth.uid())
    and account_status='active';

  if v_user is null then raise exception 'UNAUTHORIZED'; end if;
  if p_rating not in ('positive','negative') then raise exception 'INVALID_RATING'; end if;

  select * into v_message
  from public.chat_messages
  where id=p_message_id
    and sender_type='assistant';

  if not found then raise exception 'NOT_FOUND'; end if;
  if not private.chat_can_access_conversation(v_message.conversation_id) then raise exception 'FORBIDDEN'; end if;

  insert into public.chat_bot_feedback(conversation_id,message_id,user_id,rating,feedback_text)
  values(v_message.conversation_id,p_message_id,v_user,nullif(btrim(p_rating),''),nullif(btrim(p_feedback_text),''))
  on conflict(message_id,user_id) do update
    set rating=excluded.rating,
        feedback_text=excluded.feedback_text,
        created_at=now()
  returning * into v_row;

  return v_row;
end;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_notification_list(p_limit integer DEFAULT 20)
 RETURNS TABLE(id bigint, notification_type text, title text, body text, target_path text, metadata jsonb, read_at timestamp with time zone, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id bigint; v_limit integer;
begin
  select u.id into v_user_id from public.users u where u.auth_user_id = auth.uid()
    and u.account_status = 'active';
  if v_user_id is null then raise exception 'UNAUTHORIZED' using errcode = '42501'; end if;
  v_limit := greatest(1, least(coalesce(p_limit,20),100));
  return query
    select n.id,n.notification_type,n.title,n.body,n.target_path,n.metadata,n.read_at,n.created_at
    from public.powerhub_user_notifications n
    where n.user_id = v_user_id
    order by n.created_at desc,n.id desc
    limit v_limit;
end;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_notification_mark_all_read()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id bigint; v_count integer;
begin
  select u.id into v_user_id from public.users u where u.auth_user_id = auth.uid()
    and u.account_status = 'active';
  if v_user_id is null then raise exception 'UNAUTHORIZED' using errcode = '42501'; end if;
  update public.powerhub_user_notifications n set read_at = now()
   where n.user_id = v_user_id and n.read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_notification_mark_read(p_notification_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id bigint;
begin
  select u.id into v_user_id from public.users u where u.auth_user_id = auth.uid()
    and u.account_status = 'active';
  if v_user_id is null then raise exception 'UNAUTHORIZED' using errcode = '42501'; end if;
  update public.powerhub_user_notifications n set read_at = coalesce(n.read_at, now())
   where n.id = p_notification_id and n.user_id = v_user_id;
  return found;
end;
$function$;

CREATE OR REPLACE FUNCTION public.powerhub_notification_unread_count()
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_user_id bigint; v_count integer;
begin
  select u.id into v_user_id from public.users u where u.auth_user_id = auth.uid()
    and u.account_status = 'active';
  if v_user_id is null then raise exception 'UNAUTHORIZED' using errcode = '42501'; end if;
  select count(*)::integer into v_count from public.powerhub_user_notifications n
    where n.user_id = v_user_id and n.read_at is null;
  return coalesce(v_count,0);
end;
$function$;

DO $postflight$
DECLARE
  v_signature text;
  v_oid oid;
  v_config text[];
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.chat_receipts_for_message(bigint)',
    'public.chat_ai_rate_message(bigint,text,text)',
    'public.powerhub_notification_list(integer)',
    'public.powerhub_notification_mark_all_read()',
    'public.powerhub_notification_mark_read(bigint)',
    'public.powerhub_notification_unread_count()'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    SELECT proconfig INTO STRICT v_config FROM pg_proc WHERE oid=v_oid;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
       OR coalesce(array_to_string(v_config,','),'') NOT LIKE '%search_path=""%' THEN
      RAISE EXCEPTION 'CHAT_RPC_PUBLIC_SECURITY_CONTEXT_MISMATCH: %',v_signature;
    END IF;
    IF has_function_privilege('anon',v_oid,'EXECUTE')
       OR NOT has_function_privilege('authenticated',v_oid,'EXECUTE') THEN
      RAISE EXCEPTION 'CHAT_RPC_PUBLIC_ACL_MISMATCH: %',v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'private.chat_current_user_id()',
    'private.chat_mark_read(bigint)',
    'private.chat_mark_read_up_to(bigint,bigint)',
    'private.chat_rate_support(bigint,smallint,text)',
    'private.chat_reopen_support_conversation(bigint)',
    'private.chat_transition_conversation(bigint,text)',
    'private.chat_release_support(bigint)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    SELECT proconfig INTO STRICT v_config FROM pg_proc WHERE oid=v_oid;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid)
       OR coalesce(array_to_string(v_config,','),'') NOT LIKE '%search_path=""%' THEN
      RAISE EXCEPTION 'CHAT_RPC_PRIVATE_SECURITY_CONTEXT_MISMATCH: %',v_signature;
    END IF;
    IF has_function_privilege('anon',v_oid,'EXECUTE')
       OR has_function_privilege('authenticated',v_oid,'EXECUTE')
       OR has_function_privilege('service_role',v_oid,'EXECUTE') THEN
      RAISE EXCEPTION 'CHAT_RPC_PRIVATE_IMPLEMENTATION_EXPOSED: %',v_signature;
    END IF;
  END LOOP;
END
$postflight$;

SELECT pg_notify('pgrst','reload schema');
