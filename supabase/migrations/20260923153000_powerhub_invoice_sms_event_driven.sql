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


-- Optional owner-controlled batching: invoices are queued immediately but receive a
-- scheduled_at matching the next configured delivery cycle.
alter table public.tenant_messaging_configurations
  add column if not exists invoice_sms_schedule_mode text not null default 'immediate',
  add column if not exists invoice_sms_schedule_anchor_at timestamptz null;

alter table public.tenant_messaging_configurations
  drop constraint if exists tenant_messaging_configurations_invoice_sms_schedule_mode_check;

alter table public.tenant_messaging_configurations
  add constraint tenant_messaging_configurations_invoice_sms_schedule_mode_check
  check (invoice_sms_schedule_mode in ('immediate','weekly','every_10_days','every_15_days','monthly'));

alter table public.notification_messages
  add column if not exists scheduled_at timestamptz null;

create index if not exists notification_messages_sms_due_idx
  on public.notification_messages (channel, event_type, status, scheduled_at, created_at)
  where channel = 'sms' and event_type = 'invoice_issued' and status = 'pending';

create or replace function public.powerhub_invoice_sms_next_schedule(
  p_created_at timestamptz,
  p_mode text,
  p_anchor_at timestamptz
)
returns timestamptz
language plpgsql
immutable
set search_path = public, pg_temp
as $function$
declare
  v_anchor timestamptz := coalesce(p_anchor_at, p_created_at);
  v_candidate timestamptz;
  v_elapsed bigint;
  v_steps bigint;
begin
  if p_mode = 'immediate' or p_anchor_at is null then return p_created_at; end if;
  if p_mode = 'monthly' then
    v_candidate := v_anchor;
    while v_candidate < p_created_at loop v_candidate := v_candidate + interval '1 month'; end loop;
    return v_candidate;
  end if;
  v_elapsed := greatest(0, floor(extract(epoch from (p_created_at - v_anchor)) / 86400));
  if p_mode = 'weekly' then v_steps := ceil(v_elapsed / 7.0)::bigint;
  elsif p_mode = 'every_10_days' then v_steps := ceil(v_elapsed / 10.0)::bigint;
  elsif p_mode = 'every_15_days' then v_steps := ceil(v_elapsed / 15.0)::bigint;
  else return p_created_at;
  end if;
  v_candidate := v_anchor + make_interval(days => (v_steps * case when p_mode = 'weekly' then 7 when p_mode = 'every_10_days' then 10 else 15 end)::int);
  return greatest(v_candidate, p_created_at);
end;
$function$;

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
  v_schedule_mode text := 'immediate';
  v_anchor_at timestamptz;
  v_scheduled_at timestamptz;
begin
  perform pg_advisory_xact_lock(new.id);
  select * into v_subscriber from public.subscribers where id = new.subscriber_id and tenant_id = new.tenant_id and site_id = new.site_id;
  if not found then return new; end if;
  select is_enabled and coalesce((value->>'smsEnabled')::boolean, true) into v_sms_enabled
  from public.platform_settings where setting_key = 'invoice_delivery_channels';
  if coalesce(v_sms_enabled, false) is not true then return new; end if;

  select coalesce(invoice_sms_schedule_mode, 'immediate'), invoice_sms_schedule_anchor_at
    into v_schedule_mode, v_anchor_at
  from public.tenant_messaging_configurations
  where tenant_id = new.tenant_id and channel = 'sms' limit 1;
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

  insert into public.notification_messages(tenant_id, invoice_id, subscriber_id, channel, event_type, recipient, status, scheduled_at, payload)
  values (new.tenant_id, new.id, new.subscriber_id, 'sms', 'invoice_issued', coalesce(v_subscriber.phone, ''), 'pending', v_scheduled_at,
    jsonb_build_object('invoiceNo', new.invoice_no, 'billingPeriod', new.billing_period, 'totalAmount', new.total_amount, 'renderedText', v_rendered_text, 'queuedBy', 'invoice_issue', 'scheduleMode', v_schedule_mode, 'scheduledAt', v_scheduled_at))
  on conflict (tenant_id, invoice_id, channel, event_type)
    where invoice_id is not null and channel = 'sms' and event_type = 'invoice_issued' do nothing;
  return new;
end;
$function$;
