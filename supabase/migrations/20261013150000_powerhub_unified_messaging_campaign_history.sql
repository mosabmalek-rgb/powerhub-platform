-- Durable tenant/site-scoped history for manual messaging campaigns.
create or replace function public.powerhub_unified_messaging_campaign_history(
  p_tenant_id bigint,
  p_site_id bigint,
  p_limit integer default 30
)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $function$
  select coalesce(jsonb_agg(history.campaign_json order by history.created_at desc), '[]'::jsonb)
  from (
    select
      campaign.created_at,
      jsonb_build_object(
        'id', campaign.id, 'status', campaign.status, 'requested', campaign.requested,
        'queued', campaign.queued, 'submitted', campaign.submitted, 'failed', campaign.failed,
        'skipped', campaign.skipped, 'createdAt', campaign.created_at, 'updatedAt', campaign.updated_at,
        'completedAt', campaign.completed_at, 'templateName', template.name,
        'pending', counts.pending, 'processing', counts.processing, 'needsReview', counts.needs_review,
        'recipients', coalesce(recipients.rows, '[]'::jsonb)
      ) as campaign_json
    from public.powerhub_message_campaigns as campaign
    join public.powerhub_message_templates as template
      on template.id = campaign.template_id and template.tenant_id = campaign.tenant_id
    cross join lateral (
      select
        count(*) filter (where message.status = 'pending')::integer as pending,
        count(*) filter (where message.status = 'processing')::integer as processing,
        count(*) filter (where message.status = 'needs_review')::integer as needs_review
      from public.powerhub_message_campaign_recipients as recipient
      join public.notification_messages as message on message.id = recipient.notification_id
      where recipient.campaign_id = campaign.id
    ) as counts
    left join lateral (
      select jsonb_agg(jsonb_build_object(
        'notificationId', message.id, 'subscriberId', subscriber.id,
        'subscriberName', subscriber.full_name, 'subscriberNo', subscriber.subscriber_no,
        'phone', message.recipient, 'channel', message.channel, 'status', message.status,
        'attempts', message.attempts, 'lastError', message.last_error, 'createdAt', message.created_at
      ) order by subscriber.full_name, message.id) as rows
      from public.powerhub_message_campaign_recipients as recipient
      join public.notification_messages as message on message.id = recipient.notification_id
      join public.subscribers as subscriber
        on subscriber.id = recipient.subscriber_id
       and subscriber.tenant_id = campaign.tenant_id and subscriber.site_id = campaign.site_id
      where recipient.campaign_id = campaign.id
    ) as recipients on true
    where campaign.tenant_id = p_tenant_id and campaign.site_id = p_site_id
    order by campaign.created_at desc
    limit greatest(1, least(coalesce(p_limit, 30), 100))
  ) as history;
$function$;

revoke execute on function public.powerhub_unified_messaging_campaign_history(bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.powerhub_unified_messaging_campaign_history(bigint, bigint, integer) to service_role;
