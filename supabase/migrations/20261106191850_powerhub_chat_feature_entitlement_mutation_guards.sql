-- Enforce tenant chat-feature entitlements at every participant-facing
-- conversation mutation boundary. Platform Support operators retain access to
-- existing Support Center work when a tenant disables its own support feature.
-- This is a function-body hardening only; public RPC signatures and ACLs stay
-- unchanged.

DO $preflight$
DECLARE
  v_signature text;
  v_oid oid;
  v_owner text;
  v_config text[];
  v_wrapper oid;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'private.chat_reopen_support_conversation(bigint)',
    'private.chat_transition_conversation(bigint,text)',
    'private.chat_feature_enabled_for_tenant(bigint,text)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'CHAT_FEATURE_MUTATION_GUARD_DEPENDENCY_MISSING: %', v_signature;
    END IF;

    SELECT pg_get_userbyid(proowner), proconfig
      INTO v_owner, v_config
    FROM pg_proc
    WHERE oid = v_oid;

    IF v_owner <> 'postgres'
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
       OR coalesce(array_to_string(v_config, ','), '') NOT LIKE '%search_path=""%' THEN
      RAISE EXCEPTION 'CHAT_FEATURE_MUTATION_GUARD_SECURITY_CONTEXT_MISMATCH: %', v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.chat_reopen_support_conversation(bigint)',
    'public.chat_transition_conversation(bigint,text)'
  ] LOOP
    v_wrapper := to_regprocedure(v_signature);
    IF v_wrapper IS NULL
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_wrapper)
       OR coalesce(
            array_to_string((SELECT proconfig FROM pg_proc WHERE oid = v_wrapper), ','),
            ''
          ) NOT LIKE '%search_path=""%'
       OR has_function_privilege('anon', v_wrapper, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_wrapper, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_wrapper, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_wrapper),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_wrapper))
         )) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'CHAT_FEATURE_MUTATION_GUARD_PUBLIC_RPC_CONTRACT_CHANGED: %', v_signature;
    END IF;
  END LOOP;
END
$preflight$;

CREATE OR REPLACE FUNCTION private.chat_reopen_support_conversation(p_conversation_id bigint)
 RETURNS public.chat_conversations
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

  select * into v_conversation
  from public.chat_conversations
  where id = p_conversation_id;

  if not found then raise exception 'NOT_FOUND'; end if;
  if v_conversation.conversation_type <> 'support' then
    raise exception 'NOT_SUPPORT_CONVERSATION';
  end if;

  v_is_support := private.powerhub_has_platform_capability('manageSupportChat');

  if not v_is_support and not exists(
    select 1
    from public.chat_participants cp
    join public.tenant_members tm
      on tm.tenant_id = v_conversation.tenant_id
     and tm.user_id = cp.user_id
    where cp.conversation_id = p_conversation_id
      and cp.user_id = v_user
      and cp.left_at is null
      and tm.is_active = true
      and tm.membership_status = 'active'
      and (tm.expires_at is null or tm.expires_at > now())
  ) then
    raise exception 'FORBIDDEN';
  end if;

  -- A tenant participant may reopen only while Support Chat is enabled for
  -- their tenant. Platform Support remains able to process legacy tickets.
  if not v_is_support
     and not private.chat_feature_enabled_for_tenant(v_conversation.tenant_id, 'support') then
    raise exception 'CHAT_FEATURE_DISABLED' using errcode = 'P0001';
  end if;

  select reopen_window_minutes
    into v_window
  from public.chat_support_settings
  where id = true;

  if coalesce(v_conversation.resolved_at, v_conversation.closed_at) is null
     or coalesce(v_conversation.resolved_at, v_conversation.closed_at)
          < now() - (coalesce(v_window, 10080) * interval '1 minute') then
    raise exception 'REOPEN_WINDOW_EXPIRED';
  end if;

  update public.chat_conversations
  set status = 'SUPPORT_ACTIVE',
      reopened_at = now(),
      resolved_at = null,
      closed_at = null,
      auto_close_at = null,
      closed_by_user_id = null,
      close_reason = null,
      updated_at = now()
  where id = p_conversation_id
  returning * into v_conversation;

  perform private.chat_log_ticket_event(
    p_conversation_id,
    'reopened',
    jsonb_build_object('reason', 'manual_reopen'),
    null,
    'SUPPORT_ACTIVE',
    null,
    null,
    v_user
  );

  return v_conversation;
end;
$function$;

CREATE OR REPLACE FUNCTION private.chat_transition_conversation(
  p_conversation_id bigint,
  p_next_status text
)
 RETURNS public.chat_conversations
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

  select * into v_conversation
  from public.chat_conversations
  where id = p_conversation_id;

  if not found then raise exception 'NOT_FOUND'; end if;

  v_is_support := private.powerhub_has_platform_capability('manageSupportChat');

  if v_is_support and v_conversation.conversation_type <> 'support' then
    raise exception 'NOT_SUPPORT_CONVERSATION';
  end if;

  v_is_participant := exists(
    select 1
    from public.chat_participants cp
    join public.tenant_members tm
      on tm.tenant_id = v_conversation.tenant_id
     and tm.user_id = cp.user_id
    where cp.conversation_id = v_conversation.id
      and cp.user_id = v_user_id
      and cp.left_at is null
      and tm.is_active = true
      and tm.membership_status = 'active'
      and (tm.expires_at is null or tm.expires_at > now())
  );

  if not v_is_support and not v_is_participant then
    raise exception 'FORBIDDEN';
  end if;

  -- Enforce the entitlement for the conversation being mutated. The extra
  -- Support Chat check is required when a participant escalates an Assistant
  -- conversation into the Support Center, because the source conversation
  -- itself is governed by the Assistant entitlement.
  if not v_is_support
     and not private.chat_feature_enabled_for_tenant(
       v_conversation.tenant_id,
       v_conversation.conversation_type
     ) then
    raise exception 'CHAT_FEATURE_DISABLED' using errcode = 'P0001';
  end if;

  if not v_is_support
     and p_next_status in ('SUPPORT_PENDING', 'SUPPORT_ACTIVE')
     and not private.chat_feature_enabled_for_tenant(v_conversation.tenant_id, 'support') then
    raise exception 'CHAT_FEATURE_DISABLED' using errcode = 'P0001';
  end if;

  v_old_status := v_conversation.status;

  if v_is_support then
    if not (
      (v_conversation.status = 'SUPPORT_PENDING' and p_next_status = 'SUPPORT_ACTIVE') or
      (v_conversation.status = 'SUPPORT_ACTIVE' and p_next_status in ('WAITING_USER', 'RESOLVED', 'CLOSED')) or
      (v_conversation.status = 'WAITING_USER' and p_next_status in ('SUPPORT_ACTIVE', 'RESOLVED', 'CLOSED')) or
      (v_conversation.status = 'RESOLVED' and p_next_status in ('CLOSED', 'SUPPORT_ACTIVE')) or
      (v_conversation.status = 'CLOSED' and p_next_status = 'SUPPORT_ACTIVE')
    ) then
      raise exception 'INVALID_STATUS_TRANSITION';
    end if;
  else
    if not (
      (v_conversation.status = 'AI_ACTIVE' and p_next_status = 'SUPPORT_PENDING')
      or (v_conversation.status = 'WAITING_USER' and p_next_status = 'SUPPORT_ACTIVE')
      or (v_conversation.status = 'RESOLVED' and p_next_status = 'SUPPORT_ACTIVE')
    ) then
      raise exception 'INVALID_STATUS_TRANSITION';
    end if;
  end if;

  select auto_close_after_minutes
    into v_auto_close
  from public.chat_support_settings
  where id = true;

  update public.chat_conversations
  set status = p_next_status,
      resolved_at = case
        when p_next_status = 'RESOLVED' and resolved_at is null then now()
        when p_next_status = 'SUPPORT_ACTIVE' then null
        else resolved_at
      end,
      closed_at = case
        when p_next_status = 'CLOSED' then coalesce(closed_at, now())
        when p_next_status <> 'CLOSED' then null
        else closed_at
      end,
      auto_close_at = case
        when p_next_status = 'RESOLVED' then now() + (coalesce(v_auto_close, 2880) * interval '1 minute')
        when p_next_status = 'CLOSED' then null
        when p_next_status = 'SUPPORT_ACTIVE' then null
        else auto_close_at
      end,
      closed_by_user_id = case
        when p_next_status = 'CLOSED' then v_user_id
        when p_next_status <> 'CLOSED' then null
        else closed_by_user_id
      end,
      close_reason = case
        when p_next_status = 'CLOSED' then coalesce(close_reason, 'support_resolved')
        when p_next_status <> 'CLOSED' then null
        else close_reason
      end,
      reopened_at = case
        when p_next_status = 'SUPPORT_ACTIVE' and v_old_status in ('RESOLVED', 'CLOSED') then now()
        else reopened_at
      end,
      updated_at = now()
  where id = p_conversation_id
  returning * into v_conversation;

  if p_next_status in ('SUPPORT_ACTIVE', 'WAITING_USER') then
    perform private.chat_apply_sla(p_conversation_id);
  end if;

  perform private.chat_log_ticket_event(
    p_conversation_id,
    case
      when p_next_status = 'RESOLVED' then 'resolved'
      when p_next_status = 'CLOSED' then 'closed'
      when p_next_status = 'SUPPORT_ACTIVE' and v_old_status in ('RESOLVED', 'CLOSED') then 'reopened'
      else 'status_changed'
    end,
    jsonb_build_object('status', p_next_status),
    v_old_status,
    p_next_status,
    null,
    null,
    v_user_id
  );

  return v_conversation;
end;
$function$;

DO $postflight$
DECLARE
  v_signature text;
  v_oid oid;
  v_config text[];
  v_wrapper oid;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'private.chat_reopen_support_conversation(bigint)',
    'private.chat_transition_conversation(bigint,text)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);

    SELECT proconfig INTO v_config
    FROM pg_proc
    WHERE oid = v_oid;

    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
       OR coalesce(array_to_string(v_config, ','), '') NOT LIKE '%search_path=""%'
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_oid),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
         )) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'CHAT_FEATURE_MUTATION_GUARD_PRIVATE_BOUNDARY_MISMATCH: %', v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.chat_reopen_support_conversation(bigint)',
    'public.chat_transition_conversation(bigint,text)'
  ] LOOP
    v_wrapper := to_regprocedure(v_signature);
    SELECT proconfig INTO v_config
    FROM pg_proc
    WHERE oid = v_wrapper;

    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_wrapper)
       OR coalesce(array_to_string(v_config, ','), '') NOT LIKE '%search_path=""%'
       OR has_function_privilege('anon', v_wrapper, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_wrapper, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_wrapper, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM aclexplode(coalesce(
           (SELECT proacl FROM pg_proc WHERE oid = v_wrapper),
           acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_wrapper))
         )) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'CHAT_FEATURE_MUTATION_GUARD_PUBLIC_BOUNDARY_MISMATCH: %', v_signature;
    END IF;
  END LOOP;
END
$postflight$;

SELECT pg_notify('pgrst', 'reload schema');
