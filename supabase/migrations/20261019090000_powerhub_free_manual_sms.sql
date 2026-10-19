-- Support one-off SMS messages to either a subscriber or an explicitly entered phone.
-- Keep site scope on the queued row so the shared worker can validate the owning SMS account.
alter table public.notification_messages
  add column if not exists site_id bigint references public.sites(id) on delete cascade;

create index if not exists notification_messages_tenant_site_idx
  on public.notification_messages(tenant_id, site_id, created_at desc);

-- Existing messages still derive their site from subscriber_id. Free-number messages
-- carry site_id directly and intentionally do not create fake subscriber records.
do $migration$
declare
  v_signature regprocedure;
  v_definition text;
  v_updated text;
  v_signatures regprocedure[] := array[
    'public.powerhub_claim_sms_notification(bigint,bigint)'::regprocedure,
    'public.powerhub_mark_sms_provider_request_started(bigint,bigint,integer)'::regprocedure,
    'public.powerhub_mark_sms_needs_review(bigint,bigint,integer,text,text)'::regprocedure,
    'public.powerhub_finish_sms_notification(bigint,bigint,integer,boolean,text,text)'::regprocedure,
    'public.powerhub_resolve_sms_needs_review(bigint,bigint,text,text)'::regprocedure
  ];
begin
  foreach v_signature in array v_signatures loop
    select pg_get_functiondef(v_signature) into v_definition;
    v_updated := regexp_replace(
      v_definition,
      'select[[:space:]]+(subscriber[.])?site_id[[:space:]]+into[[:space:]]+v_site_id[[:space:]]+from[[:space:]]+public[.]subscribers([[:space:]]+as[[:space:]]+subscriber)?[[:space:]]+where[[:space:]]+(subscriber[.])?id[[:space:]]*=[[:space:]]*v_message[.]subscriber_id[[:space:]]+and[[:space:]]+(subscriber[.])?tenant_id[[:space:]]*=[[:space:]]*v_message[.]tenant_id[[:space:]]*;',
      'select coalesce(v_message.site_id, (select subscriber.site_id from public.subscribers as subscriber where subscriber.id = v_message.subscriber_id and subscriber.tenant_id = v_message.tenant_id)) into v_site_id;',
      'gi'
    );
    if v_updated = v_definition then
      raise exception 'Could not add direct site scope to SMS function %', v_signature;
    end if;
    execute v_updated;
  end loop;
end;
$migration$;

create or replace function public.powerhub_prepare_manual_free_sms(
  p_tenant_id bigint,
  p_site_id bigint,
  p_subscriber_id bigint,
  p_recipient text,
  p_rendered_text text,
  p_operation_id uuid,
  p_actor_user_id bigint
)
returns table(notification_id bigint, queued boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_recipient text := trim(coalesce(p_recipient, ''));
  v_text text := trim(coalesce(p_rendered_text, ''));
  v_operation_key text := 'manual-free:' || p_operation_id::text;
  v_existing public.notification_messages%rowtype;
  v_subscriber public.subscribers%rowtype;
begin
  if p_operation_id is null then raise exception 'OPERATION_ID_REQUIRED' using errcode = '22023'; end if;
  if v_recipient = '' then raise exception 'SMS_RECIPIENT_REQUIRED' using errcode = '22023'; end if;
  if v_text = '' or char_length(v_text) > 2000 then raise exception 'SMS_TEXT_INVALID' using errcode = '22023'; end if;
  if not exists(select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  if p_subscriber_id is not null then
    select * into v_subscriber
    from public.subscribers s
    where s.id = p_subscriber_id and s.tenant_id = p_tenant_id
      and s.site_id = p_site_id and s.archived_at is null;
    if not found then raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode = 'P0001'; end if;
  end if;

  select * into v_existing
  from public.notification_messages n
  where n.tenant_id = p_tenant_id and n.operation_key = v_operation_key;
  if found then
    if v_existing.site_id is distinct from p_site_id
       or v_existing.subscriber_id is distinct from p_subscriber_id
       or v_existing.channel is distinct from 'sms'
       or v_existing.event_type is distinct from 'manual'
       or v_existing.send_type is distinct from 'manual'
       or v_existing.payload->>'manualFreeText' is distinct from 'true'
       or v_existing.recipient is distinct from v_recipient
       or coalesce(v_existing.payload->>'renderedText', '') is distinct from v_text then
      raise exception 'OPERATION_ID_REUSED_WITH_DIFFERENT_MESSAGE' using errcode = 'P0001';
    end if;
    notification_id := v_existing.id;
    queued := false;
    return next;
    return;
  end if;

  insert into public.notification_messages(
    tenant_id, site_id, subscriber_id, channel, event_type, recipient,
    status, send_type, schedule_type, payload, operation_key
  ) values (
    p_tenant_id, p_site_id, p_subscriber_id, 'sms', 'manual', v_recipient,
    'pending', 'manual', 'none',
    jsonb_build_object('renderedText', v_text, 'operationId', p_operation_id::text,
                       'operationKey', v_operation_key, 'manualFreeText', true),
    v_operation_key
  )
  on conflict (tenant_id, operation_key) do nothing
  returning id into notification_id;

  if notification_id is null then
    -- A concurrent request may win the unique operation-key insert after our
    -- first lookup. Revalidate its complete message identity before treating
    -- that row as an idempotent replay; otherwise two different requests that
    -- reuse an operation ID could return or dispatch each other's message.
    select n.* into v_existing
    from public.notification_messages n
    where n.tenant_id = p_tenant_id and n.operation_key = v_operation_key;
    if not found then raise exception 'SMS_QUEUE_INSERT_FAILED' using errcode = 'P0001'; end if;
    if v_existing.site_id is distinct from p_site_id
       or v_existing.subscriber_id is distinct from p_subscriber_id
       or v_existing.channel is distinct from 'sms'
       or v_existing.event_type is distinct from 'manual'
       or v_existing.send_type is distinct from 'manual'
       or v_existing.payload->>'manualFreeText' is distinct from 'true'
       or v_existing.recipient is distinct from v_recipient
       or coalesce(v_existing.payload->>'renderedText', '') is distinct from v_text then
      raise exception 'OPERATION_ID_REUSED_WITH_DIFFERENT_MESSAGE' using errcode = 'P0001';
    end if;
    notification_id := v_existing.id;
    queued := false;
    return next;
    return;
  end if;

  insert into public.audit_logs(tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, metadata)
  values (
    p_tenant_id, p_site_id, p_actor_user_id,
    (select u.platform_role from public.users u where u.id = p_actor_user_id),
    'notification_message', notification_id::text, 'queue_manual_free_sms',
    jsonb_build_object('operationId', p_operation_id::text, 'subscriberId', p_subscriber_id,
                       'recipient', v_recipient, 'characterCount', char_length(v_text))
  );

  queued := true;
  return next;
end;
$function$;

revoke execute on function public.powerhub_prepare_manual_free_sms(bigint,bigint,bigint,text,text,uuid,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_prepare_manual_free_sms(bigint,bigint,bigint,text,text,uuid,bigint) to service_role;
