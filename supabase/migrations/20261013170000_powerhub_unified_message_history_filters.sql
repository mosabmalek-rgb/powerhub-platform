-- One canonical message stream for the owner message center.
-- A notification is the row of record; campaign/invoice/automation metadata is joined,
-- never unioned as a second "message", so the same delivery cannot be counted twice.
create or replace function public.powerhub_unified_messaging_history(
  p_tenant_id bigint,
  p_site_id bigint,
  p_period text,
  p_start_date date,
  p_end_date date,
  p_type text,
  p_channel text,
  p_status text,
  p_search text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_timezone text;
  v_start timestamptz;
  v_end timestamptz;
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_limit integer := greatest(10, least(coalesce(p_limit, 50), 100));
  v_offset integer := greatest(0, least(coalesce(p_offset, 0), 10000));
  v_result jsonb;
begin
  if p_tenant_id is null or p_tenant_id < 1 or p_site_id is null or p_site_id < 1 then
    raise exception 'INVALID_MESSAGE_HISTORY_SCOPE' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.sites s
    where s.id = p_site_id and s.tenant_id = p_tenant_id
  ) then
    raise exception 'MESSAGE_HISTORY_SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;
  if p_period not in ('cycle', 'today', 'custom') then
    raise exception 'INVALID_MESSAGE_HISTORY_PERIOD' using errcode = '22023';
  end if;
  if p_type not in ('all', 'invoice_issued', 'payment_reminder', 'payment_received',
                    'subscriber_reference', 'service_alert', 'manual', 'automatic') then
    raise exception 'INVALID_MESSAGE_HISTORY_TYPE' using errcode = '22023';
  end if;
  if p_channel not in ('all', 'sms', 'whatsapp') then
    raise exception 'INVALID_MESSAGE_HISTORY_CHANNEL' using errcode = '22023';
  end if;
  if p_status not in ('all', 'pending', 'processing', 'submitted', 'delivered', 'read', 'failed', 'needs_review') then
    raise exception 'INVALID_MESSAGE_HISTORY_STATUS' using errcode = '22023';
  end if;
  if p_period = 'custom' and (p_start_date is null or p_end_date is null or p_start_date > p_end_date) then
    raise exception 'INVALID_MESSAGE_HISTORY_DATE_RANGE' using errcode = '22023';
  end if;

  select coalesce(nullif(trim(c.timezone), ''), 'Asia/Gaza')
    into v_timezone
  from public.tenant_reading_cycle_configurations c
  where c.tenant_id = p_tenant_id and c.site_id = p_site_id;
  v_timezone := coalesce(v_timezone, 'Asia/Gaza');

  if p_period = 'cycle' then
    -- Use the site's canonical reading/billing-cycle authority, not the calendar month.
    select cycle.cycle_start_at, cycle.cycle_end_at + interval '1 millisecond'
      into v_start, v_end
    from public.powerhub_cycle_for_reading(p_tenant_id, p_site_id, now()) cycle;
  elsif p_period = 'today' then
    v_start := date_trunc('day', now() at time zone v_timezone) at time zone v_timezone;
    v_end := (date_trunc('day', now() at time zone v_timezone) + interval '1 day') at time zone v_timezone;
  else
    v_start := p_start_date::timestamp at time zone v_timezone;
    v_end := (p_end_date + 1)::timestamp at time zone v_timezone;
  end if;

  if v_start is null or v_end is null or v_end <= v_start then
    raise exception 'MESSAGE_HISTORY_PERIOD_UNAVAILABLE' using errcode = 'P0001';
  end if;

  with scoped_messages as (
    select
      m.id,
      m.tenant_id,
      m.invoice_id,
      m.subscriber_id,
      m.channel,
      m.event_type,
      m.recipient,
      m.status,
      m.provider_message_id,
      m.payload,
      m.attempts,
      m.last_error,
      m.created_at,
      m.updated_at,
      m.scheduled_at,
      m.send_type,
      m.schedule_type,
      m.operation_key,
      s.site_id as subscriber_site_id,
      s.full_name as subscriber_name,
      s.subscriber_no,
      i.site_id as invoice_site_id,
      i.invoice_no,
      c.id as campaign_id,
      coalesce(campaign_template.name, message_template.name, a.name) as template_name,
      a.id as automation_id,
      a.site_id as automation_site_id,
      a.name as automation_name,
      case
        when c.id is not null or m.event_type = 'manual' or m.send_type = 'manual' then 'manual'
        when m.automation_id is not null or m.send_type in ('automatic', 'scheduled') then 'automatic'
        else 'legacy'
      end as source_type,
      coalesce(
        m.payload ->> 'renderedText',
        m.payload ->> 'message',
        m.payload ->> 'body',
        m.payload ->> 'text',
        ''
      ) as message_text
    from public.notification_messages m
    left join public.subscribers s
      on s.id = m.subscriber_id and s.tenant_id = m.tenant_id
    left join public.invoices i
      on i.id = m.invoice_id and i.tenant_id = m.tenant_id
    left join public.powerhub_message_campaign_recipients cr
      on cr.notification_id = m.id
    left join public.powerhub_message_campaigns c
      on c.id = cr.campaign_id and c.tenant_id = m.tenant_id
    left join public.powerhub_message_templates campaign_template
      on campaign_template.id = c.template_id and campaign_template.tenant_id = c.tenant_id
    left join public.powerhub_message_templates message_template
      on message_template.id = m.template_id and message_template.tenant_id = m.tenant_id
    left join public.powerhub_message_automations a
      on a.id = m.automation_id and a.tenant_id = m.tenant_id
    where m.tenant_id = p_tenant_id
      and (
        s.site_id = p_site_id
        or i.site_id = p_site_id
        or c.site_id = p_site_id
        or a.site_id = p_site_id
        or m.payload ->> 'siteId' = p_site_id::text
      )
  ),
  filtered_messages as (
    select *
    from scoped_messages m
    where m.created_at >= v_start and m.created_at < v_end
      and (
        p_type = 'all'
        or (p_type = 'manual' and m.source_type = 'manual')
        or (p_type = 'automatic' and m.source_type = 'automatic')
        or (p_type = 'subscriber_reference' and m.event_type in ('subscriber_reference', 'subscriber_created'))
        or m.event_type = p_type
      )
      and (p_channel = 'all' or m.channel = p_channel)
      and (p_status = 'all' or m.status = p_status)
      and (
        v_search is null
        or coalesce(m.subscriber_name, '') ilike '%' || v_search || '%'
        or coalesce(m.subscriber_no, '') ilike '%' || v_search || '%'
        or coalesce(m.recipient, '') ilike '%' || v_search || '%'
        or coalesce(m.invoice_no, '') ilike '%' || v_search || '%'
        or coalesce(m.campaign_id::text, '') ilike '%' || v_search || '%'
        or coalesce(m.template_name, '') ilike '%' || v_search || '%'
        or coalesce(m.message_text, '') ilike '%' || v_search || '%'
      )
  ),
  stats as (
    select
      count(*)::integer as total,
      count(*) filter (where status in ('submitted', 'delivered', 'read'))::integer as submitted,
      count(*) filter (where status = 'failed')::integer as failed,
      count(*) filter (where status = 'pending')::integer as pending,
      count(*) filter (where status = 'processing')::integer as processing,
      count(*) filter (where status = 'needs_review')::integer as needs_review,
      count(distinct campaign_id)::integer as campaigns
    from filtered_messages
  ),
  page as (
    select coalesce(
      jsonb_agg(row_json order by created_at desc, id desc),
      '[]'::jsonb
    ) as items
    from (
      select
        m.created_at,
        m.id,
        jsonb_build_object(
          'id', m.id,
          'invoiceId', m.invoice_id,
          'invoiceNo', m.invoice_no,
          'subscriberId', m.subscriber_id,
          'subscriberName', m.subscriber_name,
          'subscriberNo', m.subscriber_no,
          'recipient', m.recipient,
          'channel', m.channel,
          'eventType', m.event_type,
          'status', m.status,
          'providerMessageId', m.provider_message_id,
          'attempts', m.attempts,
          'lastError', m.last_error,
          'messageText', m.message_text,
          'createdAt', m.created_at,
          'updatedAt', m.updated_at,
          'scheduledAt', m.scheduled_at,
          'sendType', m.send_type,
          'scheduleType', m.schedule_type,
          'source', m.source_type,
          'campaignId', m.campaign_id,
          'campaignLabel', case when m.campaign_id is null then null
                                else 'حملة #' || m.campaign_id::text ||
                                     coalesce(' — ' || m.template_name, '') end,
          'automationId', m.automation_id,
          'automationName', m.automation_name,
          'templateName', m.template_name,
          'operationKey', m.operation_key
        ) as row_json
      from filtered_messages m
      order by m.created_at desc, m.id desc
      limit v_limit offset v_offset
    ) page_rows
  )
  select jsonb_build_object(
    'items', page.items,
    'total', stats.total,
    'page', (v_offset / v_limit) + 1,
    'limit', v_limit,
    'offset', v_offset,
    'campaignCount', stats.campaigns,
    'stats', jsonb_build_object(
      'total', stats.total,
      'submitted', stats.submitted,
      'failed', stats.failed,
      'pending', stats.pending,
      'processing', stats.processing,
      'needsReview', stats.needs_review,
      'campaigns', stats.campaigns
    ),
    'period', p_period,
    'periodStart', v_start,
    'periodEndExclusive', v_end,
    'timezone', v_timezone
  )
  into v_result
  from stats cross join page;

  return coalesce(v_result, jsonb_build_object('items', '[]'::jsonb, 'total', 0, 'stats', jsonb_build_object()));
end;
$function$;

revoke execute on function public.powerhub_unified_messaging_history(bigint,bigint,text,date,date,text,text,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.powerhub_unified_messaging_history(bigint,bigint,text,date,date,text,text,text,integer,integer) to service_role;
