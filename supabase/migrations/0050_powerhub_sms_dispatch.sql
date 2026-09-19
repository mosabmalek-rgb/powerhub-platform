alter table public.notification_messages drop constraint if exists notification_messages_status_check;
alter table public.notification_messages add constraint notification_messages_status_check check (status in ('pending', 'processing', 'submitted', 'delivered', 'read', 'failed'));
alter table public.notification_messages add column if not exists character_count integer;
alter table public.notification_messages add column if not exists segment_count integer;
alter table public.notification_messages add constraint notification_messages_character_count_check check (character_count is null or character_count >= 0);
alter table public.notification_messages add constraint notification_messages_segment_count_check check (segment_count is null or segment_count >= 0);

create or replace function public.powerhub_claim_sms_notification(
  p_user_id bigint,
  p_notification_id bigint
)
returns table (
  notification_id bigint,
  tenant_id bigint,
  recipient text,
  rendered_text text,
  api_endpoint text,
  credential_ciphertext text,
  credential_iv text,
  sender_name text,
  attempt_number integer,
  character_count integer,
  segment_count integer
)
language plpgsql security invoker set search_path = public, pg_temp
as $$
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
begin
  select * into v_message from public.notification_messages where id = p_notification_id for update;
  if not found then raise exception 'NOTIFICATION_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_message.channel <> 'sms' then raise exception 'SMS_CHANNEL_REQUIRED' using errcode = 'P0001'; end if;
  if v_message.status not in ('pending', 'failed') then raise exception 'NOTIFICATION_NOT_READY' using errcode = 'P0001'; end if;
  select site_id into v_site_id from public.subscribers where id = v_message.subscriber_id and tenant_id = v_message.tenant_id;
  if v_site_id is null then raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode = 'P0001'; end if;

  select exists(select 1 from public.users where id = p_user_id and account_status = 'active' and platform_role in ('platform_owner', 'platform_admin')) into v_is_platform_admin;
  select v_is_platform_admin or exists(
    select 1
    from public.tenant_members as members
    inner join public.staff_profiles as staff on staff.user_id = members.user_id and staff.tenant_id = members.tenant_id and staff.site_id = v_site_id
    left join public.custom_permission_roles as roles on roles.id = staff.custom_role_id and roles.tenant_id = staff.tenant_id and roles.is_active = true
    where members.tenant_id = v_message.tenant_id and members.user_id = p_user_id
      and members.is_active and members.membership_status = 'active'
      and staff.is_active and (staff.suspension_ends_at is null or staff.suspension_ends_at <= now())
      and (staff.role in ('owner', 'manager', 'accountant') or coalesce(staff.permissions, roles.permissions, '[]'::jsonb) ? 'manageMessaging')
  ) into v_allowed;
  if not v_allowed then raise exception 'MESSAGING_PERMISSION_REQUIRED' using errcode = 'P0001'; end if;

  select * into v_account from public.tenant_tweetsms_accounts where tenant_tweetsms_accounts.tenant_id = v_message.tenant_id for update;
  if not found or not v_account.is_active or nullif(trim(v_account.api_endpoint), '') is null or nullif(trim(v_account.credential_ciphertext), '') is null or nullif(trim(v_account.credential_iv), '') is null or nullif(trim(v_account.sender_name), '') is null then
    raise exception 'TWEETSMS_ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  v_rendered_text := coalesce(v_message.payload->>'renderedText', '');
  if nullif(trim(v_rendered_text), '') is null then raise exception 'SMS_RENDERED_TEXT_REQUIRED' using errcode = 'P0001'; end if;
  v_character_count := char_length(v_rendered_text);
  v_segment_count := case when v_character_count <= 70 then 1 else ceil(v_character_count::numeric / 67)::integer end;
  select coalesce(sum(coalesce(messages.segment_count, 1)), 0)::integer into v_used_segments
    from public.notification_messages as messages
    where messages.tenant_id = v_message.tenant_id and messages.channel = 'sms'
      and messages.id <> v_message.id and messages.created_at >= date_trunc('month', now())
      and messages.status in ('processing', 'submitted', 'delivered', 'read', 'needs_review');
  if v_used_segments + v_segment_count > v_account.monthly_limit then raise exception 'SMS_QUOTA_EXCEEDED' using errcode = 'P0001'; end if;

  update public.notification_messages as messages
    set status = 'processing', attempts = messages.attempts + 1, last_error = null,
        character_count = v_character_count, segment_count = v_segment_count, updated_at = now()
    where messages.id = v_message.id
    returning messages.id, messages.tenant_id, messages.recipient, v_rendered_text, v_account.api_endpoint, v_account.credential_ciphertext, v_account.credential_iv, v_account.sender_name, messages.attempts, messages.character_count, messages.segment_count
    into notification_id, tenant_id, recipient, rendered_text, api_endpoint, credential_ciphertext, credential_iv, sender_name, attempt_number, character_count, segment_count;

  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, metadata)
    values (tenant_id, v_site_id, p_user_id, (select platform_role from public.users where id = p_user_id), 'notification_message', notification_id::text, 'sms_dispatch_claimed', jsonb_build_object('attempt', attempt_number, 'characterCount', character_count, 'segmentCount', segment_count));
  return next;
end;
$$;

create or replace function public.powerhub_finish_sms_notification(
  p_user_id bigint,
  p_notification_id bigint,
  p_attempt_number integer,
  p_success boolean,
  p_provider_message_id text,
  p_error text
)
returns table (notification_id bigint, status text, provider_message_id text, segment_count integer)
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_message public.notification_messages%rowtype;
  v_site_id bigint;
begin
  select * into v_message from public.notification_messages where id = p_notification_id for update;
  if not found then raise exception 'NOTIFICATION_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_message.status <> 'processing' or v_message.attempts <> p_attempt_number then raise exception 'NOTIFICATION_CLAIM_LOST' using errcode = 'P0001'; end if;
  select site_id into v_site_id from public.subscribers where id = v_message.subscriber_id and tenant_id = v_message.tenant_id;
  if v_site_id is null then raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode = 'P0001'; end if;
  update public.notification_messages as messages
    set status = case when p_success then 'submitted' else 'failed' end,
        provider_message_id = case when p_success then nullif(left(trim(coalesce(p_provider_message_id, '')), 500), '') else null end,
        last_error = case when p_success then null else coalesce(nullif(left(trim(coalesce(p_error, '')), 2000), ''), 'رفض مزود TweetSMS الإرسال.') end,
        updated_at = now()
    where messages.id = v_message.id
    returning messages.id, messages.status, messages.provider_message_id, messages.segment_count
    into notification_id, status, provider_message_id, segment_count;
  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, metadata)
    values (v_message.tenant_id, v_site_id, p_user_id, (select platform_role from public.users where id = p_user_id), 'notification_message', notification_id::text, case when p_success then 'sms_submitted_to_provider' else 'sms_submission_failed' end, jsonb_build_object('attempt', p_attempt_number, 'segmentCount', segment_count, 'providerMessageIdAvailable', p_success and provider_message_id is not null));
  return next;
end;
$$;

revoke execute on function public.powerhub_claim_sms_notification(bigint, bigint) from public, anon, authenticated;
revoke execute on function public.powerhub_finish_sms_notification(bigint, bigint, integer, boolean, text, text) from public, anon, authenticated;
grant execute on function public.powerhub_claim_sms_notification(bigint, bigint) to service_role;
grant execute on function public.powerhub_finish_sms_notification(bigint, bigint, integer, boolean, text, text) to service_role;
