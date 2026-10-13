-- Fix PL/pgSQL output-column ambiguity when refreshing manual campaign results.
-- Every reference to a campaign column is qualified because this function returns
-- fields such as id, requested, queued and completed_at.
create or replace function public.powerhub_refresh_message_campaign(
  p_tenant_id bigint,
  p_site_id bigint,
  p_campaign_id bigint
)
returns table(
  id bigint,
  status text,
  requested integer,
  queued integer,
  submitted integer,
  failed integer,
  skipped integer,
  needs_review integer,
  completed_at timestamptz
)
language plpgsql
security invoker
set search_path=public,pg_temp
as $function$
declare
  v_requested integer;
  v_queued integer;
  v_submitted integer;
  v_failed integer;
  v_processing integer;
  v_pending integer;
  v_needs_review integer;
  v_skipped integer;
  v_status text;
begin
  select campaign.requested into v_requested
  from public.powerhub_message_campaigns as campaign
  where campaign.id=p_campaign_id
    and campaign.tenant_id=p_tenant_id
    and campaign.site_id=p_site_id
  for update;
  if not found then
    raise exception 'CAMPAIGN_OUT_OF_SCOPE' using errcode='P0001';
  end if;

  select count(*)::integer into v_queued
  from public.powerhub_message_campaign_recipients as recipient
  where recipient.campaign_id=p_campaign_id;

  select
    count(*) filter (where notification.status in ('submitted','delivered','read'))::integer,
    count(*) filter (where notification.status='failed')::integer,
    count(*) filter (where notification.status='processing')::integer,
    count(*) filter (where notification.status='pending')::integer,
    count(*) filter (where notification.status='needs_review')::integer
  into v_submitted,v_failed,v_processing,v_pending,v_needs_review
  from public.powerhub_message_campaign_recipients as recipient
  join public.notification_messages as notification
    on notification.id=recipient.notification_id
  where recipient.campaign_id=p_campaign_id;

  v_skipped:=greatest(v_requested-v_queued,0);
  v_status:=case
    when v_processing>0 or v_pending>0 then 'processing'
    when v_needs_review>0 then 'partial'
    when v_failed>0 and v_submitted>0 then 'partial'
    when v_failed>0 then 'failed'
    when v_queued=0 and v_requested>0 then 'failed'
    else 'completed'
  end;

  update public.powerhub_message_campaigns as campaign
  set queued=v_queued,
      submitted=v_submitted,
      failed=v_failed,
      skipped=v_skipped,
      status=v_status,
      completed_at=case
        when v_status in ('completed','partial','failed') then coalesce(campaign.completed_at,now())
        else null
      end,
      updated_at=now()
  where campaign.id=p_campaign_id
    and campaign.tenant_id=p_tenant_id
    and campaign.site_id=p_site_id;

  return query
  select campaign.id,campaign.status,campaign.requested,campaign.queued,
         campaign.submitted,campaign.failed,campaign.skipped,
         v_needs_review,campaign.completed_at
  from public.powerhub_message_campaigns as campaign
  where campaign.id=p_campaign_id
    and campaign.tenant_id=p_tenant_id
    and campaign.site_id=p_site_id;
end;
$function$;

revoke execute on function public.powerhub_refresh_message_campaign(bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_refresh_message_campaign(bigint,bigint,bigint) to service_role;
