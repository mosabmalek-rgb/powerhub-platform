-- Keep pending invoice SMS aligned with the owner's current batching cycle.
create or replace function public.powerhub_reschedule_pending_invoice_sms(
  p_tenant_id bigint,
  p_mode text,
  p_anchor_at timestamptz
)
returns bigint
language plpgsql
set search_path = 'public','pg_temp'
as $function$
declare
  v_count bigint := 0;
begin
  if p_tenant_id is null or p_tenant_id < 1 then
    raise exception 'INVALID_TENANT_ID' using errcode = '22023';
  end if;
  if p_mode not in ('immediate', 'weekly', 'every_10_days', 'every_15_days', 'monthly') then
    raise exception 'INVALID_SMS_SCHEDULE_MODE' using errcode = '22023';
  end if;
  if p_mode <> 'immediate' and p_anchor_at is null then
    raise exception 'SCHEDULE_ANCHOR_REQUIRED' using errcode = '22023';
  end if;

  update public.notification_messages
  set scheduled_at = public.powerhub_invoice_sms_next_schedule(created_at, p_mode, p_anchor_at),
      payload = jsonb_set(
        jsonb_set(coalesce(payload, '{}'::jsonb), '{scheduleMode}', to_jsonb(p_mode), true),
        '{scheduledAt}', to_jsonb(public.powerhub_invoice_sms_next_schedule(created_at, p_mode, p_anchor_at)), true
      ),
      updated_at = now()
  where tenant_id = p_tenant_id
    and channel = 'sms'
    and event_type = 'invoice_issued'
    and status = 'pending';

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- The owner-level switch controls automatic invoice SMS creation.
create or replace function public.powerhub_queue_invoice_sms_after_issue()
returns trigger
language plpgsql
set search_path to 'public','pg_temp'
as $function$
declare
  v_subscriber public.subscribers%rowtype;
  v_template text;
  v_sms_enabled boolean := false;
  v_auto_enabled boolean := false;
  v_rendered_text text;
  v_schedule_mode text := 'immediate';
  v_anchor_at timestamptz;
  v_scheduled_at timestamptz;
begin
  perform pg_advisory_xact_lock(new.id);
  select * into v_subscriber from public.subscribers
  where id = new.subscriber_id and tenant_id = new.tenant_id and site_id = new.site_id;
  if not found then return new; end if;

  select is_enabled and coalesce((value->>'smsEnabled')::boolean, true)
    into v_sms_enabled from public.platform_settings
    where setting_key = 'invoice_delivery_channels';
  if coalesce(v_sms_enabled, false) is not true then return new; end if;

  select coalesce(auto_send_after_approval, false),
         coalesce(invoice_sms_schedule_mode, 'immediate'),
         invoice_sms_schedule_anchor_at
    into v_auto_enabled, v_schedule_mode, v_anchor_at
  from public.tenant_messaging_configurations
  where tenant_id = new.tenant_id and channel = 'sms' limit 1;
  if coalesce(v_auto_enabled, false) is not true then return new; end if;

  v_scheduled_at := public.powerhub_invoice_sms_next_schedule(new.created_at, v_schedule_mode, v_anchor_at);

  select body into v_template from public.tenant_invoice_message_templates
  where tenant_id = new.tenant_id and channel = 'sms' and event_type = 'invoice_issued' and is_active = true
  order by updated_at desc limit 1;

  v_rendered_text := coalesce(v_template, 'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.');
  v_rendered_text := replace(v_rendered_text, '{{subscriber_name}}', coalesce(v_subscriber.full_name, ''));
  v_rendered_text := replace(v_rendered_text, '{{invoice_no}}', new.invoice_no);
  v_rendered_text := replace(v_rendered_text, '{{billing_period}}', new.billing_period);
  v_rendered_text := replace(v_rendered_text, '{{total_amount}}', new.total_amount::text);
  v_rendered_text := replace(v_rendered_text, '{{due_date}}', to_char(new.due_date at time zone 'Asia/Gaza', 'YYYY-MM-DD'));

  insert into public.notification_messages(
    tenant_id, invoice_id, subscriber_id, channel, event_type, recipient, status, scheduled_at, payload
  )
  values (
    new.tenant_id, new.id, new.subscriber_id, 'sms', 'invoice_issued',
    coalesce(v_subscriber.phone, ''), 'pending', v_scheduled_at,
    jsonb_build_object('invoiceNo', new.invoice_no, 'billingPeriod', new.billing_period,
      'totalAmount', new.total_amount, 'renderedText', v_rendered_text,
      'queuedBy', 'invoice_issue', 'scheduleMode', v_schedule_mode, 'scheduledAt', v_scheduled_at)
  )
  on conflict (tenant_id, invoice_id, channel, event_type)
    where invoice_id is not null and channel = 'sms' and event_type = 'invoice_issued'
    do nothing;
  return new;
end;
$function$;
