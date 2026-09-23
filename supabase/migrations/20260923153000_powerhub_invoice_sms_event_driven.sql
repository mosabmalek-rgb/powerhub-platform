-- PowerHub: invoice SMS is the only automatic business SMS.
-- The invoice-issued notification is queued at invoice creation and dispatched
-- by the internal one-minute worker. Tenant-configurable SMS schedules are not used.

create unique index if not exists notification_messages_invoice_sms_issued_unique
  on public.notification_messages (tenant_id, invoice_id, channel, event_type)
  where invoice_id is not null and channel = 'sms' and event_type = 'invoice_issued';

create or replace function public.powerhub_queue_invoice_sms_after_issue()
returns trigger
language plpgsql
set search_path to 'public','pg_temp'
as $function$
declare
  v_subscriber public.subscribers%rowtype;
  v_template text;
  v_sms_enabled boolean := false;
  v_rendered_text text;
begin
  perform pg_advisory_xact_lock(new.id);

  select * into v_subscriber
  from public.subscribers
  where id = new.subscriber_id
    and tenant_id = new.tenant_id
    and site_id = new.site_id;

  if not found then return new; end if;

  select is_enabled and coalesce((value->>'smsEnabled')::boolean, true)
    into v_sms_enabled
  from public.platform_settings
  where setting_key = 'invoice_delivery_channels';

  if coalesce(v_sms_enabled, false) is not true then return new; end if;

  select body into v_template
  from public.tenant_invoice_message_templates
  where tenant_id = new.tenant_id
    and channel = 'sms'
    and event_type = 'invoice_issued'
    and is_active = true
  order by updated_at desc
  limit 1;

  v_rendered_text := coalesce(
    v_template,
    'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.'
  );
  v_rendered_text := replace(v_rendered_text, '{{subscriber_name}}', coalesce(v_subscriber.full_name, ''));
  v_rendered_text := replace(v_rendered_text, '{{invoice_no}}', new.invoice_no);
  v_rendered_text := replace(v_rendered_text, '{{billing_period}}', new.billing_period);
  v_rendered_text := replace(v_rendered_text, '{{total_amount}}', new.total_amount::text);
  v_rendered_text := replace(v_rendered_text, '{{due_date}}', to_char(new.due_date at time zone 'Asia/Gaza', 'YYYY-MM-DD'));

  insert into public.notification_messages(
    tenant_id, invoice_id, subscriber_id, channel, event_type, recipient, status, payload
  )
  values (
    new.tenant_id, new.id, new.subscriber_id, 'sms', 'invoice_issued',
    coalesce(v_subscriber.phone, ''), 'pending',
    jsonb_build_object(
      'invoiceNo', new.invoice_no,
      'billingPeriod', new.billing_period,
      'totalAmount', new.total_amount,
      'renderedText', v_rendered_text,
      'queuedBy', 'invoice_issue'
    )
  )
  on conflict (tenant_id, invoice_id, channel, event_type)
    where invoice_id is not null and channel = 'sms' and event_type = 'invoice_issued'
    do nothing;

  return new;
end;
$function$;
