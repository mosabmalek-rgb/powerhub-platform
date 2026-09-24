-- PowerHub: retire delivery uncertainty for SMS and keep only sent/failed business outcomes.
-- Delivery/read receipts are intentionally out of scope until a provider delivery contract exists.

alter table public.notification_messages drop constraint if exists notification_messages_status_check;
alter table public.notification_messages
  add constraint notification_messages_status_check
  check (status in ('pending','processing','submitted','delivered','read','failed'));

do $$
begin
  if to_regprocedure('public.powerhub_finish_sms_notification(bigint,bigint,integer,boolean,text,text,boolean)') is not null then
    drop function public.powerhub_finish_sms_notification(bigint,bigint,integer,boolean,text,text,boolean);
  end if;
end $$;

create or replace function public.powerhub_finish_sms_notification(
  p_user_id bigint,
  p_notification_id bigint,
  p_attempt_number integer,
  p_success boolean,
  p_provider_message_id text,
  p_error text
)
returns table(notification_id bigint,status text,provider_message_id text,segment_count integer)
language plpgsql security invoker
set search_path = public, pg_temp
as $function$
declare
  v_message public.notification_messages%rowtype;
  v_site_id bigint;
begin
  select * into v_message
  from public.notification_messages
  where id = p_notification_id
  for update;

  if not found then
    raise exception 'NOTIFICATION_NOT_FOUND' using errcode='P0001';
  end if;

  if v_message.status <> 'processing' or v_message.attempts <> p_attempt_number then
    raise exception 'NOTIFICATION_CLAIM_LOST' using errcode='P0001';
  end if;

  select site_id into v_site_id
  from public.subscribers
  where id = v_message.subscriber_id
    and tenant_id = v_message.tenant_id;

  if v_site_id is null then
    raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode='P0001';
  end if;

  update public.notification_messages as messages
  set status = case when p_success then 'submitted' else 'failed' end,
      provider_message_id = case
        when p_success then nullif(left(trim(coalesce(p_provider_message_id,'')),500), '')
        else null
      end,
      last_error = case
        when p_success then null
        else coalesce(
          nullif(left(trim(coalesce(p_error,'')),2000),''),
          'لم يثبت خصم رصيد الرسائل؛ اعتُبرت الرسالة غير مرسلة.'
        )
      end,
      updated_at = now()
  where messages.id = v_message.id
  returning messages.id, messages.status, messages.provider_message_id, messages.segment_count
  into notification_id,status,provider_message_id,segment_count;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata
  )
  values(
    v_message.tenant_id,
    v_site_id,
    p_user_id,
    (select platform_role from public.users where id=p_user_id),
    'notification_message',
    notification_id::text,
    case when p_success then 'sms_submitted_to_provider' else 'sms_submission_failed' end,
    jsonb_build_object(
      'attempt',p_attempt_number,
      'segmentCount',segment_count,
      'providerMessageIdAvailable',p_success and provider_message_id is not null
    )
  );

  return next;
end;
$function$;

revoke all on function public.powerhub_finish_sms_notification(bigint,bigint,integer,boolean,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_finish_sms_notification(bigint,bigint,integer,boolean,text,text) to service_role;
