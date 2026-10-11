-- Avoid duplicate invoice-issued SMS rows when the approval RPC handles channel notifications itself.
-- Keep the trigger lock compatible with bigint tenant and invoice identifiers.

CREATE OR REPLACE FUNCTION public.powerhub_queue_invoice_sms_after_issue()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_subscriber public.subscribers%rowtype;
  v_template public.powerhub_message_templates%rowtype;
  v_legacy_template text;
  v_sms_enabled boolean := false;
  v_auto_enabled boolean := false;
  v_invoice_style text := 'details';
  v_rendered_text text;
  v_schedule_mode text := 'immediate';
  v_anchor_at timestamptz;
  v_scheduled_at timestamptz;
  v_share_token text;
  v_invoice_link text;
  v_portal_link text;
  v_portal_code text;
  v_existing public.notification_messages%rowtype;
  v_actor_user_id bigint;
  v_base_url text;
begin
  if current_setting('powerhub.invoice_notification_handled_by_rpc', true) = 'true' then
  return new;
end if;
perform pg_advisory_xact_lock(hashtextextended(format('powerhub:invoice-sms:%s:%s', new.tenant_id, new.id), 0));

  if exists (
    select 1 from public.notification_messages
    where tenant_id=new.tenant_id and invoice_id=new.id and channel='sms' and event_type='invoice_issued'
  ) then
    return new;
  end if;

  select * into v_subscriber
  from public.subscribers
  where id=new.subscriber_id and tenant_id=new.tenant_id and site_id=new.site_id;
  if not found then return new; end if;

  select is_enabled and coalesce((value->>'smsEnabled')::boolean,true)
  into v_sms_enabled
  from public.platform_settings
  where setting_key='invoice_delivery_channels';
  if coalesce(v_sms_enabled,false) is not true then return new; end if;

  select coalesce(auto_send_after_approval,false),
         coalesce(invoice_sms_schedule_mode,'immediate'),
         invoice_sms_schedule_anchor_at,
         coalesce(invoice_message_style,'details')
  into v_auto_enabled,v_schedule_mode,v_anchor_at,v_invoice_style
  from public.tenant_messaging_configurations
  where tenant_id=new.tenant_id and channel='sms'
  limit 1;
  if coalesce(v_auto_enabled,false) is not true then return new; end if;

  select * into v_template
  from public.powerhub_message_templates
  where tenant_id=new.tenant_id and channel='sms' and event_type='invoice_issued'
  order by updated_at desc,id desc
  limit 1;

  if v_template.id is null then
    select body into v_legacy_template
    from public.tenant_invoice_message_templates
    where tenant_id=new.tenant_id and channel='sms' and event_type='invoice_issued' and is_active
    order by updated_at desc limit 1;
    v_rendered_text := coalesce(v_legacy_template,'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.');
  elsif v_template.is_active is not true then
    -- A disabled canonical template is authoritative: never silently fall back to legacy.
    return new;
  else
    v_rendered_text := v_template.body;
  end if;

  v_scheduled_at := public.powerhub_invoice_sms_next_schedule(new.created_at,v_schedule_mode,v_anchor_at);

  if position('{{invoice_link}}' in v_rendered_text) > 0 or v_invoice_style='portal_link' then
    v_base_url := public.powerhub_public_base_url();
    select id into v_actor_user_id
    from public.users
    where account_status='active' and platform_role in ('platform_owner','platform_admin')
    order by id
    limit 1;
    if v_actor_user_id is null then raise exception 'NO_PLATFORM_AUTOMATION_ACTOR' using errcode='P0001'; end if;

    v_share_token := translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_');
    perform 1 from public.powerhub_create_invoice_share_link(
      new.tenant_id,new.site_id,v_actor_user_id,new.id,
      encode(digest(v_share_token,'sha256'),'hex'),left(v_share_token,8),null
    );
    v_invoice_link := v_base_url || '/invoice/' || v_share_token;
  end if;

  select portal_code into v_portal_code
  from public.site_portal_settings
  where tenant_id=new.tenant_id and site_id=new.site_id
  limit 1;
  if v_portal_code is not null then
    v_base_url := coalesce(v_base_url,public.powerhub_public_base_url());
    v_portal_link := v_base_url || '/portal?g=' || v_portal_code;
  else
    v_portal_link := '';
  end if;

  if v_invoice_style='portal_link' and position('{{invoice_link}}' in v_rendered_text)=0 then
    v_rendered_text := rtrim(v_rendered_text) || ' رابط الفاتورة: {{invoice_link}}';
  end if;

  v_rendered_text := replace(v_rendered_text,'{{subscriber_name}}',coalesce(v_subscriber.full_name,''));
  v_rendered_text := replace(v_rendered_text,'{{subscriber_no}}',coalesce(v_subscriber.subscriber_no,''));
  v_rendered_text := replace(v_rendered_text,'{{invoice_no}}',new.invoice_no);
  v_rendered_text := replace(v_rendered_text,'{{billing_period}}',new.billing_period);
  v_rendered_text := replace(v_rendered_text,'{{total_amount}}',new.total_amount::text);
  v_rendered_text := replace(v_rendered_text,'{{balance_due}}',new.balance_due::text);
  v_rendered_text := replace(v_rendered_text,'{{due_date}}',to_char(new.due_date at time zone 'Asia/Gaza','YYYY-MM-DD'));
  v_rendered_text := replace(v_rendered_text,'{{invoice_link}}',coalesce(v_invoice_link,''));
  v_rendered_text := replace(v_rendered_text,'{{portal_link}}',coalesce(v_portal_link,''));

  insert into public.notification_messages(
    tenant_id,invoice_id,subscriber_id,channel,event_type,recipient,status,scheduled_at,send_type,schedule_type,template_id,payload,operation_key
  ) values (
    new.tenant_id,new.id,new.subscriber_id,'sms','invoice_issued',coalesce(v_subscriber.phone,''),'pending',v_scheduled_at,
    'automatic',case when v_schedule_mode='immediate' then 'none' else v_schedule_mode end,
    nullif(v_template.id,0),
    jsonb_build_object('invoiceNo',new.invoice_no,'billingPeriod',new.billing_period,'totalAmount',new.total_amount,
      'renderedText',v_rendered_text,'invoiceLink',v_invoice_link,'portalLink',v_portal_link,'queuedBy','invoice_issue',
      'scheduleMode',v_schedule_mode,'scheduledAt',v_scheduled_at,'operationKey',format('invoice:%s:invoice_issued',new.id)),
    format('invoice:%s:invoice_issued',new.id)
  )
  on conflict (tenant_id,operation_key) do nothing;

  return new;
end;
$function$
;

do $migration$
declare
  v_definition text;
  v_patched text;
begin
  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='powerhub_approve_and_issue_mobile_reading';

  if v_definition is null then
    raise exception 'POWERHUB_MOBILE_APPROVAL_FUNCTION_NOT_FOUND';
  end if;

  if position('powerhub.invoice_notification_handled_by_rpc' in v_definition) = 0 then
    v_patched := replace(
      v_definition,
      'insert into public.invoices(',
      'perform set_config(''powerhub.invoice_notification_handled_by_rpc'', ''true'', true);' || E'\ninsert into public.invoices('
    );

    if v_patched = v_definition then
      raise exception 'POWERHUB_MOBILE_APPROVAL_INSERT_ANCHOR_NOT_FOUND';
    end if;

    -- Derive the current deployed function definition first, then patch only its insertion point.
    -- This preserves each environment's already-installed invoice numbering implementation.
    execute v_patched;
  end if;
end
$migration$;
