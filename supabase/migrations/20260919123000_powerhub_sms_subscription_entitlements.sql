alter table public.sms_package_requests
  add column if not exists subscription_id bigint references public.tenant_subscriptions(id) on delete set null;

create index if not exists sms_package_requests_tenant_subscription_status_idx
  on public.sms_package_requests (tenant_id, subscription_id, status, reviewed_at);

update public.sms_package_requests as requests
set subscription_id = subscriptions.id
from lateral (
  select ts.id
  from public.tenant_subscriptions ts
  where ts.tenant_id = requests.tenant_id
  order by ts.created_at desc, ts.id desc
  limit 1
) as subscriptions
where requests.subscription_id is null;

create or replace function public.powerhub_request_sms_package(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_requested_messages integer,
  p_note text
)
returns table (request_id bigint, request_status text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_request_id bigint;
  v_platform_role text;
  v_subscription_id bigint;
begin
  if p_requested_messages is null or p_requested_messages < 1 or p_requested_messages > 100000000 then
    raise exception 'INVALID_SMS_PACKAGE_QUANTITY' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id);

  if not exists (
    select 1 from public.sites
    where id = p_site_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  select ts.id
  into v_subscription_id
  from public.tenant_subscriptions ts
  where ts.tenant_id = p_tenant_id
  order by ts.created_at desc, ts.id desc
  limit 1;

  if v_subscription_id is null then
    raise exception 'SMS_SUBSCRIPTION_REQUIRED' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.sms_package_requests
    where tenant_id = p_tenant_id and status = 'pending'
    for update
  ) then
    raise exception 'SMS_PACKAGE_REQUEST_PENDING' using errcode = 'P0001';
  end if;

  insert into public.sms_package_requests (
    tenant_id, subscription_id, requested_by_user_id, requested_messages, note
  ) values (
    p_tenant_id, v_subscription_id, p_user_id, p_requested_messages, nullif(trim(coalesce(p_note, '')), '')
  ) returning id into v_request_id;

  select platform_role into v_platform_role from public.users where id = p_user_id;

  insert into public.audit_logs (
    tenant_id, site_id, user_id, actor_platform_role, entity_type, entity_id, action, after_data, metadata
  ) values (
    p_tenant_id, p_site_id, p_user_id, v_platform_role, 'sms_package_request', v_request_id::text, 'request_sms_package',
    jsonb_build_object(
      'requestedMessages', p_requested_messages,
      'subscriptionId', v_subscription_id,
      'status', 'pending'
    ),
    jsonb_build_object('noteProvided', nullif(trim(coalesce(p_note, '')), '') is not null)
  );

  return query select v_request_id, 'pending'::text;
end;
$$;

revoke execute on function public.powerhub_request_sms_package(bigint, bigint, bigint, integer, text)
  from public, anon, authenticated;
grant execute on function public.powerhub_request_sms_package(bigint, bigint, bigint, integer, text)
  to service_role;

create or replace function public.powerhub_get_sms_quota(
  p_tenant_id bigint,
  p_period_start timestamptz default date_trunc('month', now())
)
returns table (
  subscription_id bigint,
  sms_plan_id bigint,
  plan_code text,
  plan_name text,
  base_messages bigint,
  additional_messages bigint,
  total_messages bigint,
  used_segments bigint,
  remaining_messages bigint
)
language sql
security definer
set search_path = public, pg_temp
as $function$
  with current_subscription as (
    select
      ts.id,
      ts.sms_plan_id
    from public.tenant_subscriptions ts
    where ts.tenant_id = p_tenant_id
    order by ts.created_at desc, ts.id desc
    limit 1
  ),
  plan as (
    select
      cs.id as subscription_id,
      sp.id as sms_plan_id,
      sp.code as plan_code,
      sp.name as plan_name,
      coalesce(sp.included_messages, 0)::bigint as base_messages
    from current_subscription cs
    left join public.platform_sms_plans sp on sp.id = cs.sms_plan_id
  ),
  extras as (
    select coalesce(sum(r.approved_messages), 0)::bigint as additional_messages
    from public.sms_package_requests r
    cross join plan
    where r.tenant_id = p_tenant_id
      and r.status = 'approved'
      and r.reviewed_at >= p_period_start
      and r.reviewed_at < p_period_start + interval '1 month'
      and (
        r.subscription_id = plan.subscription_id
        or (r.subscription_id is null and plan.subscription_id is not null)
      )
  ),
  usage as (
    select coalesce(sum(greatest(coalesce(m.segment_count, 1), 1)), 0)::bigint as used_segments
    from public.notification_messages m
    where m.tenant_id = p_tenant_id
      and m.channel = 'sms'
      and m.created_at >= p_period_start
      and m.status in ('processing', 'submitted', 'delivered', 'read', 'needs_review')
  )
  select
    coalesce(plan.subscription_id, null),
    coalesce(plan.sms_plan_id, null),
    coalesce(plan.plan_code, null),
    coalesce(plan.plan_name, null),
    coalesce(plan.base_messages, 0),
    extras.additional_messages,
    coalesce(plan.base_messages, 0) + extras.additional_messages,
    usage.used_segments,
    greatest((coalesce(plan.base_messages, 0) + extras.additional_messages) - usage.used_segments, 0)
  from plan
  cross join extras
  cross join usage;
$function$;

revoke all on function public.powerhub_get_sms_quota(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.powerhub_get_sms_quota(bigint, timestamptz) to service_role;

create or replace function public.powerhub_claim_sms_notification(
  p_user_id bigint,
  p_notification_id bigint
)
returns table (
  notification_id bigint,
  tenant_id bigint,
  recipient text,
  rendered_text text,
  api_endpoint text,
  credential_ciphertext text,
  credential_iv text,
  sender_name text,
  attempt_number integer,
  character_count integer,
  segment_count integer
)
language plpgsql security invoker set search_path=public,pg_temp
as $function$
declare
  v_message public.notification_messages%rowtype;
  v_account public.tenant_tweetsms_accounts%rowtype;
  v_site_id bigint;
  v_is_platform_admin boolean;
  v_allowed boolean;
  v_used_segments bigint;
  v_total_messages bigint;
  v_rendered_text text;
  v_character_count integer;
  v_segment_count integer;
  v_plan_name text;
  v_additional_messages bigint;
begin
  select * into v_message
  from public.notification_messages
  where id = p_notification_id
  for update;

  if not found then raise exception 'NOTIFICATION_NOT_FOUND' using errcode='P0001'; end if;
  if v_message.channel <> 'sms' then raise exception 'SMS_CHANNEL_REQUIRED' using errcode='P0001'; end if;
  if v_message.status not in ('pending','failed') then raise exception 'NOTIFICATION_NOT_READY' using errcode='P0001'; end if;

  select site_id into v_site_id
  from public.subscribers
  where id = v_message.subscriber_id and tenant_id = v_message.tenant_id;

  if v_site_id is null then raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode='P0001'; end if;

  select exists(
    select 1
    from public.users
    where id=p_user_id
      and account_status='active'
      and platform_role in ('platform_owner','platform_admin')
  ) into v_is_platform_admin;

  select v_is_platform_admin or exists(
    select 1
    from public.tenant_members members
    inner join public.staff_profiles staff
      on staff.user_id=members.user_id
      and staff.tenant_id=members.tenant_id
      and staff.site_id=v_site_id
    left join public.custom_permission_roles roles
      on roles.id=staff.custom_role_id
      and roles.tenant_id=staff.tenant_id
      and roles.is_active=true
    where members.tenant_id=v_message.tenant_id
      and members.user_id=p_user_id
      and members.is_active
      and members.membership_status='active'
      and staff.is_active
      and (staff.suspension_ends_at is null or staff.suspension_ends_at<=now())
      and (
        staff.role in ('owner','manager','accountant')
        or coalesce(staff.permissions,roles.permissions,'[]'::jsonb) ? 'manageMessaging'
      )
  ) into v_allowed;

  if not v_allowed then raise exception 'MESSAGING_PERMISSION_REQUIRED' using errcode='P0001'; end if;

  select * into v_account
  from public.tenant_tweetsms_accounts
  where tenant_id=v_message.tenant_id
  for update;

  if not found
     or not v_account.is_active
     or nullif(trim(v_account.api_endpoint),'') is null
     or nullif(trim(v_account.credential_ciphertext),'') is null
     or nullif(trim(v_account.credential_iv),'') is null
     or nullif(trim(v_account.sender_name),'') is null
  then
    raise exception 'TWEETSMS_ACCOUNT_NOT_ACTIVE' using errcode='P0001';
  end if;

  select
    q.used_segments,
    q.total_messages,
    q.plan_name,
    q.additional_messages
  into
    v_used_segments,
    v_total_messages,
    v_plan_name,
    v_additional_messages
  from public.powerhub_get_sms_quota(v_message.tenant_id, date_trunc('month', now())) q;

  if v_plan_name is null then
    raise exception 'SMS_PLAN_NOT_ASSIGNED' using errcode='P0001';
  end if;

  v_rendered_text:=coalesce(v_message.payload->>'renderedText','');
  if nullif(trim(v_rendered_text),'') is null then raise exception 'SMS_RENDERED_TEXT_REQUIRED' using errcode='P0001'; end if;

  v_character_count:=char_length(v_rendered_text);
  v_segment_count:=case when v_character_count<=70 then 1 else ceil(v_character_count::numeric/67)::integer end;

  if v_used_segments + v_segment_count > v_total_messages then
    raise exception 'SMS_QUOTA_EXCEEDED' using errcode='P0001';
  end if;

  update public.notification_messages messages
    set status='processing',
        attempts=messages.attempts+1,
        last_error=null,
        character_count=v_character_count,
        segment_count=v_segment_count,
        updated_at=now()
    where messages.id=v_message.id
    returning messages.id,messages.tenant_id,messages.recipient,v_rendered_text,
      v_account.api_endpoint,v_account.credential_ciphertext,v_account.credential_iv,
      v_account.sender_name,messages.attempts,messages.character_count,messages.segment_count
    into notification_id,tenant_id,recipient,rendered_text,
      api_endpoint,credential_ciphertext,credential_iv,sender_name,
      attempt_number,character_count,segment_count;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata
  )
  values(
    tenant_id,v_site_id,p_user_id,
    (select platform_role from public.users where id=p_user_id),
    'notification_message',notification_id::text,'sms_dispatch_claimed',
    jsonb_build_object(
      'attempt',attempt_number,
      'characterCount',character_count,
      'segmentCount',segment_count,
      'smsPlanName',v_plan_name,
      'additionalMessages',v_additional_messages,
      'effectiveQuota',v_total_messages
    )
  );

  return next;
end;
$function$;

revoke execute on function public.powerhub_get_sms_quota(bigint, timestamptz) from public,anon,authenticated;
grant execute on function public.powerhub_get_sms_quota(bigint, timestamptz) to service_role;
revoke execute on function public.powerhub_claim_sms_notification(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_claim_sms_notification(bigint,bigint) to service_role;
