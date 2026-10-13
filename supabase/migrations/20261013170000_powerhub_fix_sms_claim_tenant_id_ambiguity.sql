-- Fix tenant_id output-parameter ambiguity in SMS claim before it updates a queued notification.
-- The claim RPC runs before any provider call; fully qualify tenant lookups so valid campaigns can
-- acquire a claim instead of leaving notifications pending with zero attempts.
CREATE OR REPLACE FUNCTION public.powerhub_claim_sms_notification(p_user_id bigint, p_notification_id bigint)
 RETURNS TABLE(notification_id bigint, tenant_id bigint, recipient text, rendered_text text, api_endpoint text, credential_ciphertext text, credential_iv text, sender_name text, attempt_number integer, character_count integer, segment_count integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_message public.notification_messages%rowtype;
  v_account public.tenant_tweetsms_accounts%rowtype;
  v_site_id bigint;
  v_is_platform_admin boolean;
  v_allowed boolean;
  v_used_segments integer;
  v_rendered_text text;
  v_character_count integer;
  v_segment_count integer;
  v_feature_policy record;
begin
  select *
  into v_message
  from public.notification_messages
  where id = p_notification_id
  for update;

  if not found then
    raise exception 'NOTIFICATION_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_message.channel <> 'sms' then
    raise exception 'SMS_CHANNEL_REQUIRED' using errcode = 'P0001';
  end if;

  if v_message.status not in ('pending', 'failed') then
    raise exception 'NOTIFICATION_NOT_READY' using errcode = 'P0001';
  end if;

  select subscriber.site_id
  into v_site_id
  from public.subscribers as subscriber
  where subscriber.id = v_message.subscriber_id
    and subscriber.tenant_id = v_message.tenant_id;

  if v_site_id is null then
    raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode = 'P0001';
  end if;

  select exists(
    select 1
    from public.users
    where id = p_user_id
      and account_status = 'active'
      and platform_role in ('platform_owner', 'platform_admin')
  )
  into v_is_platform_admin;

  select v_is_platform_admin or exists(
    select 1
    from public.tenant_members as members
    inner join public.staff_profiles as staff
      on staff.user_id = members.user_id
     and staff.tenant_id = members.tenant_id
     and staff.site_id = v_site_id
    left join public.custom_permission_roles as roles
      on roles.id = staff.custom_role_id
     and roles.tenant_id = staff.tenant_id
     and roles.is_active = true
    where members.tenant_id = v_message.tenant_id
      and members.user_id = p_user_id
      and members.is_active
      and members.membership_status = 'active'
      and staff.is_active
      and (staff.suspension_ends_at is null or staff.suspension_ends_at <= now())
      and (
        staff.role in ('owner', 'manager', 'accountant')
        or coalesce(staff.permissions, roles.permissions, '[]'::jsonb) ? 'manageMessaging'
      )
  )
  into v_allowed;

  if not v_allowed then
    raise exception 'MESSAGING_PERMISSION_REQUIRED' using errcode = 'P0001';
  end if;

  select *
  into v_feature_policy
  from public.powerhub_resolve_tenant_feature_policy(v_message.tenant_id, 'sms');

  if not coalesce(v_feature_policy.eligible, false)
     or not coalesce(v_feature_policy.enabled, false) then
    raise exception 'SMS_FEATURE_DISABLED' using errcode = 'P0001';
  end if;

  select account.*
  into v_account
  from public.tenant_tweetsms_accounts as account
  where account.tenant_id = v_message.tenant_id
  for update;

  if not found
     or not v_account.is_active
     or nullif(trim(v_account.api_endpoint), '') is null
     or nullif(trim(v_account.credential_ciphertext), '') is null
     or nullif(trim(v_account.credential_iv), '') is null
     or nullif(trim(v_account.sender_name), '') is null then
    raise exception 'TWEETSMS_ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  if v_account.sms_dispatch_lease_until is not null
     and v_account.sms_dispatch_lease_until > now() then
    return;
  end if;

  v_rendered_text := coalesce(v_message.payload->>'renderedText', '');

  if nullif(trim(v_rendered_text), '') is null then
    raise exception 'SMS_RENDERED_TEXT_REQUIRED' using errcode = 'P0001';
  end if;

  v_character_count := char_length(v_rendered_text);
  v_segment_count := case
    when v_character_count <= 70 then 1
    else ceil(v_character_count::numeric / 67)::integer
  end;

  select coalesce(sum(coalesce(messages.segment_count, 1)), 0)::integer
  into v_used_segments
  from public.notification_messages as messages
  where messages.tenant_id = v_message.tenant_id
    and messages.channel = 'sms'
    and messages.id <> v_message.id
    and messages.created_at >= date_trunc('month', now())
    and messages.status in ('processing', 'submitted', 'delivered', 'read', 'needs_review');

  if v_feature_policy.effective_limit is not null
     and v_used_segments + v_segment_count > v_feature_policy.effective_limit then
    raise exception 'SMS_QUOTA_EXCEEDED' using errcode = 'P0001';
  end if;

  update public.notification_messages as messages
  set status = 'processing',
      attempts = messages.attempts + 1,
      provider_request_started_at = null,
      last_error = null,
      character_count = v_character_count,
      segment_count = v_segment_count,
      updated_at = now()
  where messages.id = v_message.id
  returning
    messages.id,
    messages.tenant_id,
    messages.recipient,
    v_rendered_text,
    v_account.api_endpoint,
    v_account.credential_ciphertext,
    v_account.credential_iv,
    v_account.sender_name,
    messages.attempts,
    messages.character_count,
    messages.segment_count
  into
    notification_id,
    tenant_id,
    recipient,
    rendered_text,
    api_endpoint,
    credential_ciphertext,
    credential_iv,
    sender_name,
    attempt_number,
    character_count,
    segment_count;

  -- Lease the account only after the notification processing lease has been set.
  update public.tenant_tweetsms_accounts as account
  set sms_dispatch_lease_notification_id = v_message.id,
      sms_dispatch_lease_until = now() + interval '10 minutes'
  where account.tenant_id = v_message.tenant_id;

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    metadata
  )
  values(
    tenant_id,
    v_site_id,
    p_user_id,
    (select platform_role from public.users where id = p_user_id),
    'notification_message',
    notification_id::text,
    'sms_dispatch_claimed',
    jsonb_build_object(
      'attempt', attempt_number,
      'characterCount', character_count,
      'segmentCount', segment_count,
      'effectiveLimit', v_feature_policy.effective_limit,
      'limitMode', v_feature_policy.effective_limit_mode
    )
  );

  return next;
end;
$function$
;

revoke all on function public.powerhub_claim_sms_notification(bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_claim_sms_notification(bigint,bigint) to service_role;
