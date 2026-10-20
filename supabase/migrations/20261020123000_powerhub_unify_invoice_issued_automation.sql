-- Unify invoice-issued SMS settings with the general automation record.
-- Existing tenants are backfilled; invoice SMS remains event-driven and idempotent.
-- The general automation row now owns template, enabled state, and invoice send cadence.

with ranked as (
  select id,
         row_number() over (
           partition by tenant_id, site_id
           order by enabled desc, updated_at desc, id desc
         ) as rn
  from public.powerhub_message_automations
  where event_type = 'invoice_issued'
    and archived_at is null
)
update public.powerhub_message_automations a
set enabled = false,
    archived_at = coalesce(a.archived_at, now()),
    updated_at = now()
from ranked r
where r.id = a.id and r.rn > 1;

create unique index if not exists powerhub_invoice_issued_automation_per_site_uidx
  on public.powerhub_message_automations(tenant_id, site_id)
  where event_type = 'invoice_issued' and archived_at is null;

insert into public.powerhub_message_templates(
  tenant_id, name, description, channel, event_type, body, variables, is_active, version
)
select distinct c.tenant_id,
       'قالب رسائل الفواتير',
       'قالب فاتورة موحّد للاستخدام من الأتمتة العامة.',
       'sms',
       'invoice_issued',
       coalesce(
         legacy.body,
         'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.'
       ),
       jsonb_build_array(
         '{{subscriber_name}}','{{subscriber_no}}','{{invoice_no}}','{{billing_period}}',
         '{{total_amount}}','{{balance_due}}','{{due_date}}','{{previous_reading}}',
         '{{current_reading}}','{{consumption_kwh}}','{{total_balance}}','{{invoice_link}}','{{portal_link}}'
       ),
       true,
       1
from public.tenant_messaging_configurations c
left join lateral (
  select t.body
  from public.tenant_invoice_message_templates t
  where t.tenant_id = c.tenant_id
    and t.channel = 'sms'
    and t.event_type = 'invoice_issued'
    and t.is_active = true
  order by t.updated_at desc, t.id desc
  limit 1
) legacy on true
where c.channel = 'sms'
  and exists (select 1 from public.sites s where s.tenant_id = c.tenant_id)
  and not exists (
    select 1 from public.powerhub_message_templates t
    where t.tenant_id = c.tenant_id
      and t.channel = 'sms'
      and t.event_type = 'invoice_issued'
  )
on conflict do nothing;

insert into public.powerhub_message_automations(
  tenant_id, site_id, template_id, name, event_type, send_type, schedule_type,
  schedule_anchor_at, timezone, audience, trigger_config, enabled, archived_at
)
select c.tenant_id,
       s.id,
       t.id,
       left('إرسال الفواتير #' || s.id::text || ' - ' || coalesce(s.name, 'فرع'), 120),
       'invoice_issued',
       case
         when coalesce(c.invoice_sms_schedule_mode, 'immediate') <> 'immediate'
           and c.invoice_sms_schedule_anchor_at is not null
         then 'scheduled'
         else 'automatic'
       end,
       case
         when coalesce(c.invoice_sms_schedule_mode, 'immediate') <> 'immediate'
           and c.invoice_sms_schedule_anchor_at is not null
         then c.invoice_sms_schedule_mode
         else 'none'
       end,
       case
         when coalesce(c.invoice_sms_schedule_mode, 'immediate') <> 'immediate'
           and c.invoice_sms_schedule_anchor_at is not null
         then c.invoice_sms_schedule_anchor_at
         else null
       end,
       'Asia/Gaza',
       '{}'::jsonb,
       '{}'::jsonb,
       coalesce(c.auto_send_after_approval, false) and t.is_active,
       null
from public.tenant_messaging_configurations c
join public.sites s on s.tenant_id = c.tenant_id
join lateral (
  select mt.id, mt.is_active
  from public.powerhub_message_templates mt
  where mt.tenant_id = c.tenant_id
    and mt.channel = 'sms'
    and mt.event_type = 'invoice_issued'
  order by mt.updated_at desc, mt.id desc
  limit 1
) t on true
where c.channel = 'sms'
  and not exists (
    select 1 from public.powerhub_message_automations a
    where a.tenant_id = c.tenant_id
      and a.site_id = s.id
      and a.event_type = 'invoice_issued'
  )
on conflict do nothing;

create or replace function public.powerhub_enqueue_invoice_sms(
  p_tenant_id bigint,
  p_site_id bigint,
  p_invoice_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_invoice public.invoices%rowtype;
  v_subscriber public.subscribers%rowtype;
  v_automation public.powerhub_message_automations%rowtype;
  v_template public.powerhub_message_templates%rowtype;
  v_legacy_template text;
  v_sms_enabled boolean := false;
  v_auto_enabled boolean := false;
  v_invoice_style text := 'details';
  v_rendered_text text;
  v_schedule_mode text := 'immediate';
  v_anchor_at timestamptz;
  v_scheduled_at timestamptz;
  v_send_type text := 'automatic';
  v_share_token text;
  v_invoice_link text;
  v_portal_link text;
  v_portal_code text;
  v_actor_user_id bigint;
  v_base_url text;
  v_notification_id bigint;
  v_has_automation boolean := false;
  v_automation_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(format('powerhub:invoice-sms:%s:%s', p_tenant_id, p_invoice_id), 0));

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and tenant_id = p_tenant_id and site_id = p_site_id;
  if not found then return null; end if;

  select n.id into v_notification_id
  from public.notification_messages n
  where n.tenant_id = p_tenant_id and n.invoice_id = p_invoice_id
    and n.channel = 'sms' and n.event_type = 'invoice_issued'
  order by n.id limit 1;
  if v_notification_id is not null then return v_notification_id; end if;

  select * into v_subscriber
  from public.subscribers
  where id = v_invoice.subscriber_id and tenant_id = p_tenant_id and site_id = p_site_id;
  if not found then return null; end if;

  select is_enabled and coalesce((value->>'smsEnabled')::boolean, true)
  into v_sms_enabled
  from public.platform_settings where setting_key = 'invoice_delivery_channels';
  if coalesce(v_sms_enabled, false) is not true then return null; end if;

  select coalesce(c.invoice_message_style, 'details')
  into v_invoice_style
  from public.tenant_messaging_configurations c
  where c.tenant_id = p_tenant_id and c.channel = 'sms' limit 1;
  v_invoice_style := coalesce(v_invoice_style, 'details');

  select * into v_automation
  from public.powerhub_message_automations a
  where a.tenant_id = p_tenant_id and a.site_id = p_site_id and a.event_type = 'invoice_issued'
  order by (a.archived_at is null) desc, a.updated_at desc, a.id desc
  limit 1;
  v_has_automation := found;

  if v_has_automation then
    if v_automation.archived_at is not null or v_automation.enabled is not true then return null; end if;
    v_automation_id := v_automation.id;
    select * into v_template
    from public.powerhub_message_templates t
    where t.id = v_automation.template_id and t.tenant_id = p_tenant_id
      and t.channel = 'sms' and t.event_type = 'invoice_issued';
    if not found or v_template.is_active is not true then return null; end if;
    v_rendered_text := v_template.body;
    if v_automation.send_type = 'scheduled'
       and v_automation.schedule_type in ('weekly','every_10_days','every_15_days','monthly')
       and v_automation.schedule_anchor_at is not null then
      v_schedule_mode := v_automation.schedule_type;
      v_anchor_at := v_automation.schedule_anchor_at;
      v_send_type := 'scheduled';
    else
      v_schedule_mode := 'immediate';
      v_anchor_at := null;
      v_send_type := 'automatic';
    end if;
  else
    select coalesce(c.auto_send_after_approval, false),
           coalesce(c.invoice_sms_schedule_mode, 'immediate'),
           c.invoice_sms_schedule_anchor_at,
           coalesce(c.invoice_message_style, 'details')
    into v_auto_enabled, v_schedule_mode, v_anchor_at, v_invoice_style
    from public.tenant_messaging_configurations c
    where c.tenant_id = p_tenant_id and c.channel = 'sms' limit 1;
    if coalesce(v_auto_enabled, false) is not true then return null; end if;
    select * into v_template
    from public.powerhub_message_templates t
    where t.tenant_id = p_tenant_id and t.channel = 'sms' and t.event_type = 'invoice_issued'
    order by t.updated_at desc, t.id desc limit 1;
    if v_template.id is null then
      select t.body into v_legacy_template
      from public.tenant_invoice_message_templates t
      where t.tenant_id = p_tenant_id and t.channel = 'sms'
        and t.event_type = 'invoice_issued' and t.is_active
      order by t.updated_at desc, t.id desc limit 1;
      v_rendered_text := coalesce(v_legacy_template, 'PowerHub: {{subscriber_name}}، فاتورتك {{invoice_no}} للفترة {{billing_period}} بقيمة {{total_amount}}. الاستحقاق: {{due_date}}.');
    elsif v_template.is_active is not true then
      return null;
    else
      v_rendered_text := v_template.body;
    end if;
    v_send_type := 'automatic';
  end if;

  v_invoice_style := coalesce(v_invoice_style, 'details');
  v_scheduled_at := public.powerhub_invoice_sms_next_schedule(v_invoice.created_at, v_schedule_mode, v_anchor_at);

  if position('{{invoice_link}}' in v_rendered_text) > 0 or v_invoice_style = 'portal_link' then
    v_base_url := public.powerhub_public_base_url();
    select u.id into v_actor_user_id
    from public.users u
    where u.account_status = 'active' and u.platform_role in ('platform_owner','platform_admin')
    order by u.id limit 1;
    if v_actor_user_id is null then raise exception 'NO_PLATFORM_AUTOMATION_ACTOR' using errcode = 'P0001'; end if;
    v_share_token := translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_');
    perform 1 from public.powerhub_create_invoice_share_link(
      p_tenant_id, p_site_id, v_actor_user_id, v_invoice.id,
      encode(digest(v_share_token, 'sha256'), 'hex'), left(v_share_token, 8), null
    );
    v_invoice_link := v_base_url || '/invoice/' || v_share_token;
  end if;

  select p.portal_code into v_portal_code
  from public.site_portal_settings p
  where p.tenant_id = p_tenant_id and p.site_id = p_site_id limit 1;
  if v_portal_code is not null then
    v_base_url := coalesce(v_base_url, public.powerhub_public_base_url());
    v_portal_link := v_base_url || '/portal?g=' || v_portal_code;
  else
    v_portal_link := '';
  end if;

  if v_invoice_style = 'portal_link' and position('{{invoice_link}}' in v_rendered_text) = 0 then
    v_rendered_text := rtrim(v_rendered_text) || ' رابط الفاتورة: {{invoice_link}}';
  end if;

  v_rendered_text := replace(v_rendered_text, '{{subscriber_name}}', coalesce(v_subscriber.full_name, ''));
  v_rendered_text := replace(v_rendered_text, '{{subscriber_no}}', coalesce(v_subscriber.subscriber_no, ''));
  v_rendered_text := replace(v_rendered_text, '{{invoice_no}}', coalesce(v_invoice.invoice_no, ''));
  v_rendered_text := replace(v_rendered_text, '{{billing_period}}', coalesce(v_invoice.billing_period, ''));
  v_rendered_text := replace(v_rendered_text, '{{total_amount}}', public.powerhub_format_message_amount(p_tenant_id, p_site_id, v_invoice.total_amount));
  v_rendered_text := replace(v_rendered_text, '{{balance_due}}', public.powerhub_format_message_amount(p_tenant_id, p_site_id, v_invoice.balance_due));
  v_rendered_text := replace(v_rendered_text, '{{previous_reading}}', coalesce(v_invoice.previous_reading::text, ''));
  v_rendered_text := replace(v_rendered_text, '{{current_reading}}', coalesce(v_invoice.current_reading::text, ''));
  v_rendered_text := replace(v_rendered_text, '{{consumption_kwh}}', coalesce(v_invoice.consumption_kwh::text, ''));
  v_rendered_text := replace(v_rendered_text, '{{total_balance}}', public.powerhub_format_message_amount(
    p_tenant_id,
    p_site_id,
    coalesce((
      select sum(i.balance_due)
      from public.invoices i
      where i.tenant_id = p_tenant_id
        and i.site_id = p_site_id
        and i.subscriber_id = v_invoice.subscriber_id
        and i.status in ('issued','partially_paid','overdue')
        and i.balance_due > 0
    ), 0)
  ));
  v_rendered_text := replace(v_rendered_text, '{{due_date}}', to_char(v_invoice.due_date at time zone 'Asia/Gaza', 'YYYY-MM-DD'));
  v_rendered_text := replace(v_rendered_text, '{{invoice_link}}', coalesce(v_invoice_link, ''));
  v_rendered_text := replace(v_rendered_text, '{{portal_link}}', coalesce(v_portal_link, ''));

  insert into public.notification_messages(
    tenant_id, invoice_id, subscriber_id, channel, event_type, recipient, status,
    scheduled_at, send_type, schedule_type, template_id, automation_id, payload, operation_key
  ) values (
    p_tenant_id, v_invoice.id, v_invoice.subscriber_id, 'sms', 'invoice_issued',
    coalesce(v_subscriber.phone, ''), 'pending', v_scheduled_at, v_send_type,
    case when v_schedule_mode = 'immediate' then 'none' else v_schedule_mode end,
    nullif(v_template.id, 0), v_automation_id,
    jsonb_build_object('invoiceNo', v_invoice.invoice_no, 'billingPeriod', v_invoice.billing_period,
      'totalAmount', v_invoice.total_amount, 'renderedText', v_rendered_text, 'invoiceLink', v_invoice_link,
      'portalLink', v_portal_link, 'queuedBy', 'invoice_issue', 'scheduleMode', v_schedule_mode,
      'scheduledAt', v_scheduled_at, 'automationId', v_automation_id,
      'operationKey', format('invoice:%s:invoice_issued', v_invoice.id)),
    format('invoice:%s:invoice_issued', v_invoice.id)
  )
  on conflict (tenant_id, operation_key) do nothing
  returning id into v_notification_id;

  if v_notification_id is null then
    select n.id into v_notification_id from public.notification_messages n
    where n.tenant_id = p_tenant_id and n.invoice_id = p_invoice_id
      and n.channel = 'sms' and n.event_type = 'invoice_issued'
    order by n.id limit 1;
  end if;
  return v_notification_id;
end;
$function$;

revoke all on function public.powerhub_enqueue_invoice_sms(bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_enqueue_invoice_sms(bigint,bigint,bigint) to service_role;

-- Reapply a saved automation's delivery cycle to already-queued automatic messages in
-- this site only. Explicit manual sends retain their immediate/manual behavior.
create or replace function public.powerhub_reschedule_invoice_issued_automation(
  p_tenant_id bigint,
  p_site_id bigint,
  p_automation_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_automation public.powerhub_message_automations%rowtype;
  v_mode text := 'immediate';
  v_anchor timestamptz;
  v_count bigint := 0;
begin
  select * into v_automation
  from public.powerhub_message_automations a
  where a.id = p_automation_id
    and a.tenant_id = p_tenant_id
    and a.site_id = p_site_id
    and a.event_type = 'invoice_issued';
  if not found then raise exception 'INVOICE_AUTOMATION_OUT_OF_SCOPE' using errcode = 'P0001'; end if;

  -- Disabling/archiving stops future enqueueing but must not release already-scheduled
  -- pending messages early by turning their delivery time into "immediate".
  if v_automation.enabled is not true or v_automation.archived_at is not null then
    return 0;
  end if;

  if v_automation.send_type = 'scheduled'
     and v_automation.schedule_type in ('weekly','every_10_days','every_15_days','monthly')
     and v_automation.schedule_anchor_at is not null then
    v_mode := v_automation.schedule_type;
    v_anchor := v_automation.schedule_anchor_at;
  end if;

  update public.notification_messages n
  set scheduled_at = public.powerhub_invoice_sms_next_schedule(i.created_at, v_mode, v_anchor),
      schedule_type = case when n.send_type = 'manual' then n.schedule_type when v_mode = 'immediate' then 'none' else v_mode end,
      send_type = case when n.send_type = 'manual' then 'manual' when v_mode = 'immediate' then 'automatic' else 'scheduled' end,
      automation_id = v_automation.id,
      payload = jsonb_set(
        jsonb_set(coalesce(n.payload, '{}'::jsonb), '{scheduleMode}', to_jsonb(v_mode), true),
        '{scheduledAt}', to_jsonb(public.powerhub_invoice_sms_next_schedule(i.created_at, v_mode, v_anchor)), true
      ),
      updated_at = now()
  from public.invoices i
  where n.tenant_id = p_tenant_id
    and n.invoice_id = i.id
    and i.tenant_id = p_tenant_id
    and i.site_id = p_site_id
    and n.channel = 'sms'
    and n.event_type = 'invoice_issued'
    and n.status = 'pending'
    and coalesce(n.send_type, 'automatic') <> 'manual';

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.powerhub_reschedule_invoice_issued_automation(bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_reschedule_invoice_issued_automation(bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_queue_invoice_sms_after_issue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if current_setting('powerhub.invoice_notification_handled_by_rpc', true) = 'true' then return new; end if;
  perform public.powerhub_enqueue_invoice_sms(new.tenant_id, new.site_id, new.id);
  return new;
end;
$function$;

revoke execute on function public.powerhub_queue_invoice_sms_after_issue() from public, anon, authenticated;
grant execute on function public.powerhub_queue_invoice_sms_after_issue() to service_role;

do $migration$
declare
  v_definition text;
  v_patched text;
  v_issue_anchor text := $anchor$select issued.invoice_id, issued.invoice_no, issued.total_amount
into v_invoice_id, v_invoice_no, v_total_amount
from public.powerhub_issue_invoice_from_reading(
  p_tenant_id,
  p_site_id,
  p_user_id,
  p_reading_id,
  v_tariff.id,
  p_billing_period,
  p_due_date,
  p_discount_amount,
  null
) as issued;$anchor$;
  v_issue_replacement text := $replacement$perform set_config('powerhub.invoice_notification_handled_by_rpc', 'true', true);
select issued.invoice_id, issued.invoice_no, issued.total_amount
into v_invoice_id, v_invoice_no, v_total_amount
from public.powerhub_issue_invoice_from_reading(
  p_tenant_id,
  p_site_id,
  p_user_id,
  p_reading_id,
  v_tariff.id,
  p_billing_period,
  p_due_date,
  p_discount_amount,
  null
) as issued;
perform set_config('powerhub.invoice_notification_handled_by_rpc', 'false', true);
v_notification_id := public.powerhub_enqueue_invoice_sms(p_tenant_id, p_site_id, v_invoice_id);
if v_notification_id is not null then
  v_notification_ids := array_append(v_notification_ids, v_notification_id);
  v_has_channel := true;
end if;$replacement$;
  v_template_anchor text := 'select t.body into v_template from public.tenant_invoice_message_templates t';
begin
  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'powerhub_approve_and_issue_mobile_reading' and p.pronargs = 8;
  if v_definition is null then raise exception 'POWERHUB_MOBILE_APPROVAL_FUNCTION_NOT_FOUND'; end if;

  if position('public.powerhub_enqueue_invoice_sms(' in v_definition) = 0 then
    v_patched := replace(v_definition, v_issue_anchor, v_issue_replacement);
    if v_patched = v_definition then
      raise exception 'POWERHUB_MOBILE_APPROVAL_INVOICE_ISSUE_ANCHOR_NOT_FOUND';
    end if;

    v_definition := v_patched;
    v_patched := replace(
      v_definition,
      v_template_anchor,
      'if v_channel = ''sms'' then continue; end if;' || E'\n    ' || v_template_anchor
    );
    if v_patched = v_definition then
      raise exception 'POWERHUB_MOBILE_APPROVAL_SMS_LOOP_ANCHOR_NOT_FOUND';
    end if;
    execute v_patched;
  end if;

  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='powerhub_approve_and_issue_mobile_reading' and p.pronargs=8;
  if position('public.powerhub_enqueue_invoice_sms(' in v_definition)=0
     or position('powerhub.invoice_notification_handled_by_rpc' in v_definition)=0
     or position('if v_channel = ''sms'' then continue; end if;' in v_definition)=0 then
    raise exception 'POWERHUB_MOBILE_APPROVAL_UNIFIED_SMS_VALIDATION_FAILED';
  end if;
end
$migration$;

comment on column public.powerhub_message_automations.event_type is
  'Business event for unified messaging automation; invoice_issued is dispatched per invoice by the invoice issuance hook.';
