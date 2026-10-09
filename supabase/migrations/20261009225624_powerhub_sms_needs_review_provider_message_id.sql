-- PowerHub: preserve provider message IDs for SMS outcomes that require review.
-- Version matches the migration already applied through the Supabase migration tool.
create or replace function public.powerhub_mark_sms_needs_review(
  p_user_id bigint,
  p_notification_id bigint,
  p_attempt_number integer,
  p_error text,
  p_provider_message_id text default null
)
returns table(notification_id bigint, status text, attempt_number integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_message public.notification_messages%rowtype;
  v_site_id bigint;
begin
  select *
    into v_message
  from public.notification_messages
  where id = p_notification_id
  for update;

  if not found then
    raise exception 'NOTIFICATION_NOT_FOUND' using errcode='P0001';
  end if;

  if v_message.status <> 'processing' or v_message.attempts <> p_attempt_number then
    raise exception 'NOTIFICATION_CLAIM_LOST' using errcode='P0001';
  end if;

  if v_message.provider_request_started_at is null then
    raise exception 'SMS_PROVIDER_REQUEST_NOT_STARTED' using errcode='P0001';
  end if;

  select site_id
    into v_site_id
  from public.subscribers
  where id = v_message.subscriber_id
    and tenant_id = v_message.tenant_id;

  if v_site_id is null then
    raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode='P0001';
  end if;

  update public.notification_messages as messages
  set status = 'needs_review',
      provider_message_id = coalesce(
        nullif(trim(p_provider_message_id), ''),
        v_message.provider_message_id
      ),
      last_error = coalesce(
        nullif(left(trim(coalesce(p_error, '')), 2000), ''),
        'تعذر تثبيت نتيجة الإرسال؛ يلزم مراجعة النتيجة قبل إعادة المحاولة.'
      ),
      updated_at = now()
  where messages.id = v_message.id
  returning messages.id, messages.status, messages.attempts
    into notification_id, status, attempt_number;

  insert into public.audit_logs(
    tenant_id, site_id, user_id, actor_platform_role,
    entity_type, entity_id, action, metadata
  )
  values(
    v_message.tenant_id,
    v_site_id,
    p_user_id,
    (select platform_role from public.users where id = p_user_id),
    'notification_message',
    notification_id::text,
    'sms_delivery_uncertain_needs_review',
    jsonb_build_object(
      'attempt', p_attempt_number,
      'providerMessageIdAvailable', nullif(trim(coalesce(p_provider_message_id, '')), '') is not null,
      'automaticRetryBlocked', true
    )
  );

  return next;
end;
$function$;

revoke all on function public.powerhub_mark_sms_needs_review(bigint,bigint,integer,text,text)
  from public, anon, authenticated;
grant execute on function public.powerhub_mark_sms_needs_review(bigint,bigint,integer,text,text)
  to service_role;
