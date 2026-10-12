-- Fix ambiguous PL/pgSQL output-column references in subscriber updates and manual campaigns.
CREATE OR REPLACE FUNCTION public.powerhub_update_subscriber(p_tenant_id bigint, p_site_id bigint, p_user_id bigint, p_subscriber_id bigint, p_full_name text, p_phone text, p_address text, p_subscription_type text, p_service_status text, p_expected_updated_at timestamp with time zone, p_client_operation_id uuid)
 RETURNS TABLE(updated_at timestamp with time zone, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_existing public.subscribers%rowtype;
  v_updated_at timestamptz;
  v_response jsonb;
  v_platform_role text;
begin
  if p_client_operation_id is not null then
    perform pg_advisory_xact_lock(hashtext('subscriber-update:' || p_user_id::text || ':' || p_client_operation_id::text));
    select response into v_response
    from public.offline_sync_operations
    where user_id = p_user_id and client_operation_id = p_client_operation_id::text
    limit 1;
    if found then
      if not exists (
        select 1 from public.offline_sync_operations op
        where op.user_id = p_user_id
          and op.client_operation_id = p_client_operation_id::text
          and op.tenant_id = p_tenant_id
          and op.site_id = p_site_id
          and op.operation_type = 'subscriber_update'
          and op.entity_id = p_subscriber_id
      ) then raise exception 'SUBSCRIBER_OPERATION_SCOPE_CONFLICT' using errcode = 'P0001'; end if;
      if coalesce(v_response->>'updatedAt', '') = '' then
        raise exception 'INVALID_SUBSCRIBER_OPERATION_REPLAY' using errcode = 'P0001';
      end if;
      return query select (v_response->>'updatedAt')::timestamptz, true;
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(p_subscriber_id);

  select * into v_existing
  from public.subscribers
  where id = p_subscriber_id and tenant_id = p_tenant_id and site_id = p_site_id
  for update;
  if not found then
    raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  if p_expected_updated_at is not null and v_existing.updated_at <> p_expected_updated_at then
    raise exception 'SUBSCRIBER_VERSION_CONFLICT' using errcode = 'P0001';
  end if;

  update public.subscribers
  set full_name = p_full_name, phone = p_phone, address = nullif(p_address, ''), subscription_type = p_subscription_type, service_status = p_service_status
  where id = p_subscriber_id
  returning subscribers.updated_at into v_updated_at;

  select platform_role into v_platform_role from public.users where id = p_user_id;
  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, before_data, after_data
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'subscriber', p_subscriber_id::text, 'update',
    jsonb_build_object('fullName', v_existing.full_name, 'phone', v_existing.phone, 'address', v_existing.address, 'subscriptionType', v_existing.subscription_type, 'serviceStatus', v_existing.service_status, 'updatedAt', v_existing.updated_at),
    jsonb_build_object('siteId', p_site_id, 'fullName', p_full_name, 'phone', p_phone, 'address', nullif(p_address, ''), 'subscriptionType', p_subscription_type, 'serviceStatus', p_service_status, 'updatedAt', v_updated_at, 'clientOperationId', p_client_operation_id)
  );

  if p_client_operation_id is not null then
    insert into public.offline_sync_operations (
      tenant_id, site_id, user_id, client_operation_id, operation_type, entity_type, entity_id, response
    ) values (
      p_tenant_id, p_site_id, p_user_id, p_client_operation_id::text, 'subscriber_update', 'subscriber', p_subscriber_id,
      jsonb_build_object('success', true, 'updatedAt', v_updated_at)
    );
  end if;

  return query select v_updated_at, false;
end;
$function$


CREATE OR REPLACE FUNCTION public.powerhub_prepare_manual_message_campaign(p_tenant_id bigint, p_site_id bigint, p_template_id bigint, p_operation_id uuid, p_subscriber_ids bigint[], p_actor_user_id bigint)
 RETURNS TABLE(campaign_id bigint, requested integer, queued integer, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_campaign public.powerhub_message_campaigns%rowtype;
  v_template public.powerhub_message_templates%rowtype;
  v_sub public.subscribers%rowtype;
  v_notification_id bigint;
  v_portal_code text;
  v_base_url text;
  v_rendered text;
  v_ids bigint[];
begin
  if p_operation_id is null then raise exception 'OPERATION_ID_REQUIRED' using errcode='22023'; end if;
  if coalesce(array_length(p_subscriber_ids,1),0) < 1 or coalesce(array_length(p_subscriber_ids,1),0) > 500 then
    raise exception 'INVALID_MANUAL_SELECTION' using errcode='P0001';
  end if;

  select * into v_template
  from public.powerhub_message_templates
  where id=p_template_id and tenant_id=p_tenant_id and is_active
  for share;
  if not found then raise exception 'TEMPLATE_OUT_OF_SCOPE' using errcode='P0001'; end if;
  if v_template.channel <> 'sms' then raise exception 'MANUAL_SMS_ONLY' using errcode='P0001'; end if;
  if v_template.event_type is not null
     and v_template.event_type not in ('subscriber_created','service_alert') then
    raise exception 'MANUAL_TEMPLATE_CONTEXT_REQUIRED' using errcode='P0001';
  end if;

  if p_subscriber_ids is null then raise exception 'INVALID_MANUAL_SELECTION' using errcode='P0001'; end if;
  select array_agg(distinct value order by value) into v_ids
  from unnest(p_subscriber_ids) as value;

  if (select count(*) from public.subscribers s where s.tenant_id=p_tenant_id and s.site_id=p_site_id and s.id=any(v_ids) and s.archived_at is null) <> array_length(v_ids,1) then
    raise exception 'SUBSCRIBER_OUT_OF_SCOPE' using errcode='P0001';
  end if;

insert into public.powerhub_message_campaigns(
  tenant_id,site_id,template_id,operation_id,status,requested,created_by
) values (
  p_tenant_id,p_site_id,p_template_id,p_operation_id,'queued',array_length(v_ids,1),p_actor_user_id
)
on conflict (tenant_id,site_id,operation_id) do nothing
returning * into v_campaign;

if v_campaign.id is null then
  select * into v_campaign
  from public.powerhub_message_campaigns
  where tenant_id=p_tenant_id and site_id=p_site_id and operation_id=p_operation_id
  for update;
  campaign_id := v_campaign.id;
  requested := v_campaign.requested;
  queued := v_campaign.queued;
  replayed := true;
  return next;
  return;
end if;

  v_base_url := public.powerhub_public_base_url();

  select portal_code into v_portal_code
  from public.site_portal_settings
  where tenant_id=p_tenant_id and site_id=p_site_id
  limit 1;

  for v_sub in
    select *
    from public.subscribers
    where tenant_id=p_tenant_id and site_id=p_site_id and id=any(v_ids) and archived_at is null
    order by id
  loop
    v_rendered := v_template.body;
    v_rendered := replace(v_rendered,'{{subscriber_name}}',coalesce(v_sub.full_name,''));
    v_rendered := replace(v_rendered,'{{subscriber_no}}',coalesce(v_sub.subscriber_no,''));
    v_rendered := replace(v_rendered,'{{portal_link}}',
      case when v_portal_code is null then '' else v_base_url || '/portal?g=' || v_portal_code end);

    if v_rendered ~ '{{\\s*(invoice_no|billing_period|total_amount|balance_due|due_date|invoice_link)\\s*}}' then
      raise exception 'MANUAL_TEMPLATE_CONTEXT_REQUIRED' using errcode='P0001';
    end if;

    insert into public.notification_messages(
      tenant_id,subscriber_id,channel,event_type,recipient,status,send_type,schedule_type,template_id,
      payload,operation_key
    ) values (
      p_tenant_id,v_sub.id,'sms','manual',coalesce(v_sub.phone,''),'pending','manual','none',v_template.id,
      jsonb_build_object('renderedText',v_rendered,'campaignId',v_campaign.id,'operationId',p_operation_id::text,
                         'operationKey',format('manual:%s:%s',p_operation_id::text,v_sub.id)),
      format('manual:%s:%s',p_operation_id::text,v_sub.id)
    )
    on conflict (tenant_id,operation_key) do nothing
    returning id into v_notification_id;

    if v_notification_id is not null then
      insert into public.powerhub_message_campaign_recipients(campaign_id,subscriber_id,notification_id)
      values(v_campaign.id,v_sub.id,v_notification_id)
      on conflict do nothing;
    end if;
  end loop;

  update public.powerhub_message_campaigns
  set queued=(select count(*) from public.powerhub_message_campaign_recipients where campaign_id=v_campaign.id),
      requested=array_length(v_ids,1),
      updated_at=now()
  where id=v_campaign.id
  returning powerhub_message_campaigns.queued into queued;

  campaign_id := v_campaign.id;
  requested := array_length(v_ids,1);
  replayed := false;
  return next;
end;
$function$

