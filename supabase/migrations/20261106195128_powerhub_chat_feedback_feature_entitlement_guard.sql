-- Keep Support feedback behind the same tenant feature boundary as the
-- conversation reads and other participant-facing mutations.
-- The public RPC contract and platform-support authorization are unchanged.

DO $preflight$
DECLARE
  v_private oid := to_regprocedure('private.chat_rate_support(bigint,smallint,text)');
  v_public oid := to_regprocedure('public.chat_rate_support(bigint,smallint,text)');
  v_config text[];
BEGIN
  IF v_private IS NULL OR v_public IS NULL THEN
    RAISE EXCEPTION 'CHAT_FEEDBACK_FEATURE_GUARD_DEPENDENCY_MISSING';
  END IF;
  SELECT proconfig INTO v_config FROM pg_proc WHERE oid=v_private;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_private)
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=v_private)) <> 'postgres'
     OR coalesce(array_to_string(v_config,','),'') NOT LIKE '%search_path=""%'
     OR has_function_privilege('anon',v_private,'EXECUTE')
     OR has_function_privilege('authenticated',v_private,'EXECUTE')
     OR has_function_privilege('service_role',v_private,'EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_FEEDBACK_PRIVATE_SECURITY_BOUNDARY_MISMATCH';
  END IF;
  SELECT proconfig INTO v_config FROM pg_proc WHERE oid=v_public;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_public)
     OR coalesce(array_to_string(v_config,','),'') NOT LIKE '%search_path=""%'
     OR has_function_privilege('anon',v_public,'EXECUTE')
     OR NOT has_function_privilege('authenticated',v_public,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_public,'EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_FEEDBACK_PUBLIC_RPC_CONTRACT_MISMATCH';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION private.chat_rate_support(
  p_conversation_id bigint,
  p_rating smallint,
  p_comment text DEFAULT NULL::text
)
RETURNS public.chat_support_feedback
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

  select * into v_conv
  from public.chat_conversations
  where id=p_conversation_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_conv.conversation_type <> 'support' then raise exception 'NOT_SUPPORT_CONVERSATION'; end if;
  if v_conv.status not in ('RESOLVED','CLOSED') then raise exception 'FEEDBACK_ONLY_AFTER_RESOLUTION'; end if;

  if not exists(
    select 1
    from public.chat_participants cp
    join public.tenant_members tm
      on tm.tenant_id=v_conv.tenant_id and tm.user_id=cp.user_id
    where cp.conversation_id=p_conversation_id
      and cp.user_id=v_user
      and cp.left_at is null
      and tm.is_active=true
      and tm.membership_status='active'
      and (tm.expires_at is null or tm.expires_at>now())
  ) then
    raise exception 'FORBIDDEN';
  end if;

  -- Prevent a direct-RPC bypass when the tenant has disabled Support Chat.
  if not private.chat_feature_enabled_for_tenant(v_conv.tenant_id,'support') then
    raise exception 'CHAT_FEATURE_DISABLED' using errcode='P0001';
  end if;

  if p_rating not between 1 and 5 then raise exception 'INVALID_RATING'; end if;
  insert into public.chat_support_feedback(conversation_id,tenant_id,user_id,rating,comment)
  values(p_conversation_id,v_conv.tenant_id,v_user,p_rating,nullif(btrim(p_comment),''))
  on conflict (conversation_id,user_id) do update
    set rating=excluded.rating,comment=excluded.comment,created_at=now()
  returning * into v_row;

  perform private.chat_log_ticket_event(
    p_conversation_id,'customer_rated',jsonb_build_object('rating',p_rating),null,null,null,null,v_user
  );
  return v_row;
end;
$function$;

DO $postflight$
DECLARE
  v_private oid := to_regprocedure('private.chat_rate_support(bigint,smallint,text)');
  v_public oid := to_regprocedure('public.chat_rate_support(bigint,smallint,text)');
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_private)
     OR has_function_privilege('anon',v_private,'EXECUTE')
     OR has_function_privilege('authenticated',v_private,'EXECUTE')
     OR has_function_privilege('service_role',v_private,'EXECUTE')
     OR has_function_privilege('anon',v_public,'EXECUTE')
     OR NOT has_function_privilege('authenticated',v_public,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_public,'EXECUTE') THEN
    RAISE EXCEPTION 'CHAT_FEEDBACK_FEATURE_GUARD_POSTFLIGHT_FAILED';
  END IF;
END
$postflight$;

SELECT pg_notify('pgrst','reload schema');
