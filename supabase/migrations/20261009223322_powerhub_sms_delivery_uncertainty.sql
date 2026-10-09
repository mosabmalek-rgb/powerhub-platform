-- PowerHub: make SMS delivery uncertainty non-retryable by automatic reclaim.
-- A provider may accept the SMS before the final status RPC succeeds.
-- In that case the notification must be isolated in needs_review, not returned to pending.

alter table public.notification_messages
  drop constraint if exists notification_messages_status_check;

alter table public.notification_messages
  add constraint notification_messages_status_check
  check (status in ('pending','processing','submitted','delivered','read','failed','needs_review'));

alter table public.notification_messages
  add column if not exists provider_request_started_at timestamptz;

alter table public.tenant_tweetsms_accounts
  add column if not exists sms_dispatch_lease_notification_id bigint,
  add column if not exists sms_dispatch_lease_until timestamptz;

create index if not exists tenant_tweetsms_dispatch_lease_idx
  on public.tenant_tweetsms_accounts (sms_dispatch_lease_until, tenant_id);

create or replace function public.powerhub_mark_sms_needs_review(
  p_user_id bigint,
  p_notification_id bigint,
  p_attempt_number integer,
  p_error text
)
returns table(
  notification_id bigint,
  status text,
  attempt_number integer
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_message public.notification_messages%rowtype;
  v_site_id bigint;
begin
  select *
  into v_message
  from public.notification_messages
  where id = p_notification_id
  for update;

  if not found then
    raise exception 'NOTIFICATION_NOT_FOUND' using errcode='P0001';
  end if;

  if v_message.status <> 'processing' or v_message.attempts <> p_attempt_number then
    raise exception 'NOTIFICATION_CLAIM_LOST' using errcode='P0001';
  end if;

  select site_id
    into v_site_id
  from public.subscribers
  where id = v_message.subscriber_id
    and tenant_id = v_message.tenant_id;

  if v_site_id is null then
    raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode='P0001';
  end if;

  update public.notification_messages as messages
  set status = 'needs_review',
      last_error = coalesce(
        nullif(left(trim(coalesce(p_error,'')), 2000), ''),
        'تعذر تثبيت نتيجة الإرسال؛ يلزم مراجعة النتيجة قبل إعادة المحاولة.'
      ),
      updated_at = now()
  where messages.id = v_message.id
  returning messages.id, messages.status, messages.attempts
    into notification_id, status, attempt_number;

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    metadata
  )
  values(
    v_message.tenant_id,
    v_site_id,
    p_user_id,
    (select platform_role from public.users where id = p_user_id),
    'notification_message',
    notification_id::text,
    'sms_delivery_uncertain_needs_review',
    jsonb_build_object(
      'attempt', p_attempt_number,
      'automaticRetryBlocked', true
    )
  );

  return next;
end;
$function$;

revoke all on function public.powerhub_mark_sms_needs_review(bigint,bigint,integer,text)
  from public, anon, authenticated;
grant execute on function public.powerhub_mark_sms_needs_review(bigint,bigint,integer,text)
  to service_role;


-- Keep the authoritative SMS claim/quota gate consistent with needs_review accounting.
-- A provider-accepted but DB-unconfirmed delivery consumes quota and remains non-retryable.
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
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_message public.notification_messages%rowtype;
  v_account public.tenant_tweetsms_accounts%rowtype;
  v_site_id bigint;
  v_is_platform_admin boolean;
  v_allowed boolean;
  v_used_segments integer;
  v_rendered_text text;
  v_character_count integer;
  v_segment_count integer;
  v_feature_policy record;
begin
  select *
  into v_message
  from public.notification_messages
  where id = p_notification_id
  for update;

  if not found then
    raise exception 'NOTIFICATION_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_message.channel <> 'sms' then
    raise exception 'SMS_CHANNEL_REQUIRED' using errcode = 'P0001';
  end if;

  if v_message.status not in ('pending', 'failed') then
    raise exception 'NOTIFICATION_NOT_READY' using errcode = 'P0001';
  end if;

  select site_id
  into v_site_id
  from public.subscribers
  where id = v_message.subscriber_id
    and tenant_id = v_message.tenant_id;

  if v_site_id is null then
    raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode = 'P0001';
  end if;

  select exists(
    select 1
    from public.users
    where id = p_user_id
      and account_status = 'active'
      and platform_role in ('platform_owner', 'platform_admin')
  )
  into v_is_platform_admin;

  select v_is_platform_admin or exists(
    select 1
    from public.tenant_members as members
    inner join public.staff_profiles as staff
      on staff.user_id = members.user_id
     and staff.tenant_id = members.tenant_id
     and staff.site_id = v_site_id
    left join public.custom_permission_roles as roles
      on roles.id = staff.custom_role_id
     and roles.tenant_id = staff.tenant_id
     and roles.is_active = true
    where members.tenant_id = v_message.tenant_id
      and members.user_id = p_user_id
      and members.is_active
      and members.membership_status = 'active'
      and staff.is_active
      and (staff.suspension_ends_at is null or staff.suspension_ends_at <= now())
      and (
        staff.role in ('owner', 'manager', 'accountant')
        or coalesce(staff.permissions, roles.permissions, '[]'::jsonb) ? 'manageMessaging'
      )
  )
  into v_allowed;

  if not v_allowed then
    raise exception 'MESSAGING_PERMISSION_REQUIRED' using errcode = 'P0001';
  end if;

  select *
  into v_feature_policy
  from public.powerhub_resolve_tenant_feature_policy(v_message.tenant_id, 'sms');

  if not coalesce(v_feature_policy.eligible, false)
     or not coalesce(v_feature_policy.enabled, false) then
    raise exception 'SMS_FEATURE_DISABLED' using errcode = 'P0001';
  end if;

  select *
  into v_account
  from public.tenant_tweetsms_accounts
  where tenant_id = v_message.tenant_id
  for update;

  if not found
     or not v_account.is_active
     or nullif(trim(v_account.api_endpoint), '') is null
     or nullif(trim(v_account.credential_ciphertext), '') is null
     or nullif(trim(v_account.credential_iv), '') is null
     or nullif(trim(v_account.sender_name), '') is null then
    raise exception 'TWEETSMS_ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  if v_account.sms_dispatch_lease_until is not null
     and v_account.sms_dispatch_lease_until > now() then
    return;
  end if;

  v_rendered_text := coalesce(v_message.payload->>'renderedText', '');

  if nullif(trim(v_rendered_text), '') is null then
    raise exception 'SMS_RENDERED_TEXT_REQUIRED' using errcode = 'P0001';
  end if;

  v_character_count := char_length(v_rendered_text);
  v_segment_count := case
    when v_character_count <= 70 then 1
    else ceil(v_character_count::numeric / 67)::integer
  end;

  select coalesce(sum(coalesce(messages.segment_count, 1)), 0)::integer
  into v_used_segments
  from public.notification_messages as messages
  where messages.tenant_id = v_message.tenant_id
    and messages.channel = 'sms'
    and messages.id <> v_message.id
    and messages.created_at >= date_trunc('month', now())
    and messages.status in ('processing', 'submitted', 'delivered', 'read', 'needs_review');

  if v_feature_policy.effective_limit is not null
     and v_used_segments + v_segment_count > v_feature_policy.effective_limit then
    raise exception 'SMS_QUOTA_EXCEEDED' using errcode = 'P0001';
  end if;

  update public.notification_messages as messages
  set status = 'processing',
      attempts = messages.attempts + 1,
      provider_request_started_at = null,
      last_error = null,
      character_count = v_character_count,
      segment_count = v_segment_count,
      updated_at = now()
  where messages.id = v_message.id
  returning
    messages.id,
    messages.tenant_id,
    messages.recipient,
    v_rendered_text,
    v_account.api_endpoint,
    v_account.credential_ciphertext,
    v_account.credential_iv,
    v_account.sender_name,
    messages.attempts,
    messages.character_count,
    messages.segment_count
  into
    notification_id,
    tenant_id,
    recipient,
    rendered_text,
    api_endpoint,
    credential_ciphertext,
    credential_iv,
    sender_name,
    attempt_number,
    character_count,
    segment_count;

  -- Lease the account only after the notification processing lease has been set.
  update public.tenant_tweetsms_accounts
  set sms_dispatch_lease_notification_id = v_message.id,
      sms_dispatch_lease_until = now() + interval '10 minutes'
  where tenant_id = v_message.tenant_id;

  insert into public.audit_logs(
    tenant_id,
    site_id,
    user_id,
    actor_platform_role,
    entity_type,
    entity_id,
    action,
    metadata
  )
  values(
    tenant_id,
    v_site_id,
    p_user_id,
    (select platform_role from public.users where id = p_user_id),
    'notification_message',
    notification_id::text,
    'sms_dispatch_claimed',
    jsonb_build_object(
      'attempt', attempt_number,
      'characterCount', character_count,
      'segmentCount', segment_count,
      'effectiveLimit', v_feature_policy.effective_limit,
      'limitMode', v_feature_policy.effective_limit_mode
    )
  );

  return next;
end;
$function$;


revoke all on function public.powerhub_claim_sms_notification(bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_claim_sms_notification(bigint,bigint) to service_role;


create or replace function public.powerhub_mark_sms_provider_request_started(
  p_user_id bigint, p_notification_id bigint, p_attempt_number integer
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_message public.notification_messages%rowtype;
  v_site_id bigint;
  v_platform_role text;
begin
  select * into v_message from public.notification_messages
  where id=p_notification_id for update;
  if not found or v_message.channel<>'sms' or v_message.status<>'processing' or v_message.attempts<>p_attempt_number then
    raise exception 'NOTIFICATION_CLAIM_LOST' using errcode='P0001';
  end if;
  if not exists (
    select 1 from public.tenant_tweetsms_accounts a
    where a.tenant_id=v_message.tenant_id
      and a.sms_dispatch_lease_notification_id=v_message.id
      and a.sms_dispatch_lease_until>now()
  ) then raise exception 'SMS_DISPATCH_LEASE_LOST' using errcode='P0001'; end if;

  select site_id into v_site_id from public.subscribers
  where id=v_message.subscriber_id and tenant_id=v_message.tenant_id;
  if v_site_id is null then raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode='P0001'; end if;
  select platform_role into v_platform_role from public.users
  where id=p_user_id and account_status='active';
  if not found then raise exception 'ACTIVE_ACTOR_REQUIRED' using errcode='P0001'; end if;

  update public.notification_messages
  set provider_request_started_at=now(), updated_at=now()
  where id=v_message.id and status='processing' and attempts=p_attempt_number;

  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata)
  values(v_message.tenant_id,v_site_id,p_user_id,v_platform_role,'notification_message',v_message.id::text,
    'sms_provider_request_started',jsonb_build_object('attempt',p_attempt_number,'providerOutcomeMayBeAmbiguous',true));
  return true;
end;
$function$;

drop function if exists public.powerhub_mark_sms_needs_review(bigint,bigint,integer,text);

create or replace function public.powerhub_mark_sms_needs_review(
  p_user_id bigint,p_notification_id bigint,p_attempt_number integer,p_error text,
  p_provider_message_id text default null
)
returns table(notification_id bigint,status text,attempt_number integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_message public.notification_messages%rowtype;
  v_site_id bigint;
  v_platform_role text;
begin
  select * into v_message from public.notification_messages where id=p_notification_id for update;
  if not found then raise exception 'NOTIFICATION_NOT_FOUND' using errcode='P0001'; end if;
  if v_message.channel<>'sms' or v_message.status<>'processing' or v_message.attempts<>p_attempt_number then
    raise exception 'NOTIFICATION_CLAIM_LOST' using errcode='P0001';
  end if;
  select site_id into v_site_id from public.subscribers
  where id=v_message.subscriber_id and tenant_id=v_message.tenant_id;
  if v_site_id is null then raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode='P0001'; end if;
  select platform_role into v_platform_role from public.users where id=p_user_id and account_status='active';
  if not found then raise exception 'ACTIVE_ACTOR_REQUIRED' using errcode='P0001'; end if;

  update public.notification_messages messages
  set status='needs_review',
      provider_message_id=coalesce(nullif(left(trim(coalesce(p_provider_message_id,'')),500),''),messages.provider_message_id),
      last_error=coalesce(nullif(left(trim(coalesce(p_error,'')),2000),''),
        'تعذر تثبيت نتيجة الإرسال؛ يلزم مراجعة النتيجة قبل إعادة المحاولة.'),
      updated_at=now()
  where messages.id=v_message.id
  returning messages.id,messages.status,messages.attempts into notification_id,status,attempt_number;

  update public.tenant_tweetsms_accounts
  set sms_dispatch_lease_notification_id=null,sms_dispatch_lease_until=null
  where tenant_id=v_message.tenant_id and sms_dispatch_lease_notification_id=v_message.id;

  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata)
  values(v_message.tenant_id,v_site_id,p_user_id,v_platform_role,'notification_message',notification_id::text,
    'sms_delivery_uncertain_needs_review',jsonb_build_object('attempt',p_attempt_number,'automaticRetryBlocked',true,
    'providerMessageIdAvailable',nullif(trim(coalesce(p_provider_message_id,'')),'') is not null));
  return next;
end;
$function$;

create or replace function public.powerhub_finish_sms_notification(
  p_user_id bigint,p_notification_id bigint,p_attempt_number integer,p_success boolean,
  p_provider_message_id text,p_error text
)
returns table(notification_id bigint,status text,provider_message_id text,segment_count integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_message public.notification_messages%rowtype;
  v_site_id bigint;
  v_platform_role text;
begin
  select * into v_message from public.notification_messages where id=p_notification_id for update;
  if not found then raise exception 'NOTIFICATION_NOT_FOUND' using errcode='P0001'; end if;
  if v_message.status<>'processing' or v_message.attempts<>p_attempt_number then
    raise exception 'NOTIFICATION_CLAIM_LOST' using errcode='P0001';
  end if;
  select site_id into v_site_id from public.subscribers
  where id=v_message.subscriber_id and tenant_id=v_message.tenant_id;
  if v_site_id is null then raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode='P0001'; end if;
  select platform_role into v_platform_role from public.users where id=p_user_id and account_status='active';
  if not found then raise exception 'ACTIVE_ACTOR_REQUIRED' using errcode='P0001'; end if;

  update public.notification_messages messages
  set status=case when p_success then 'submitted' else 'failed' end,
      provider_message_id=case when p_success then nullif(left(trim(coalesce(p_provider_message_id,'')),500),'') else null end,
      last_error=case when p_success then null else coalesce(nullif(left(trim(coalesce(p_error,'')),2000),''),'لم يثبت خصم رصيد الرسائل؛ اعتُبرت الرسالة غير مرسلة.') end,
      updated_at=now()
  where messages.id=v_message.id
  returning messages.id,messages.status,messages.provider_message_id,messages.segment_count
  into notification_id,status,provider_message_id,segment_count;

  update public.tenant_tweetsms_accounts
  set sms_dispatch_lease_notification_id=null,sms_dispatch_lease_until=null
  where tenant_id=v_message.tenant_id and sms_dispatch_lease_notification_id=v_message.id;

  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata)
  values(v_message.tenant_id,v_site_id,p_user_id,v_platform_role,'notification_message',notification_id::text,
    case when p_success then 'sms_submitted_to_provider' else 'sms_submission_failed' end,
    jsonb_build_object('attempt',p_attempt_number,'segmentCount',segment_count,
      'providerMessageIdAvailable',p_success and provider_message_id is not null,
      'providerRequestStartedAt',v_message.provider_request_started_at));
  return next;
end;
$function$;

create or replace function public.powerhub_reclaim_stale_sms_notifications(p_limit integer default 200)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare v_reclaimed integer:=0;
begin
  if p_limit is null or p_limit<1 or p_limit>1000 then
    raise exception 'INVALID_RECLAIM_LIMIT' using errcode='22023';
  end if;
  with stale as (
    select id from public.notification_messages
    where channel='sms' and status='processing' and (lease_until is null or lease_until<now())
    order by coalesce(lease_until,created_at),id
    for update skip locked limit p_limit
  )
  update public.notification_messages messages
  set status=case when messages.provider_request_started_at is null then 'pending' else 'needs_review' end,
      next_attempt_at=case when messages.provider_request_started_at is null then now() else messages.next_attempt_at end,
      last_error=case
        when messages.provider_request_started_at is null then coalesce(messages.last_error,'استُعيدت رسالة SMS بعد انتهاء مهلة العامل قبل بدء طلب المزود.')
        else 'انتهت مهلة عامل بعد بدء طلب المزود؛ قد تكون الرسالة أُرسلت، لذا أُوقفت إعادة المحاولة التلقائية وتحتاج مراجعة.'
      end,
      updated_at=now()
  from stale where messages.id=stale.id;
  get diagnostics v_reclaimed=row_count;

  update public.tenant_tweetsms_accounts
  set sms_dispatch_lease_notification_id=null,sms_dispatch_lease_until=null
  where sms_dispatch_lease_until is not null and sms_dispatch_lease_until<=now();
  return v_reclaimed;
end;
$function$;

revoke all on function public.powerhub_mark_sms_provider_request_started(bigint,bigint,integer) from public,anon,authenticated;
grant execute on function public.powerhub_mark_sms_provider_request_started(bigint,bigint,integer) to service_role;
revoke all on function public.powerhub_mark_sms_needs_review(bigint,bigint,integer,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_mark_sms_needs_review(bigint,bigint,integer,text,text) to service_role;
revoke all on function public.powerhub_finish_sms_notification(bigint,bigint,integer,boolean,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_finish_sms_notification(bigint,bigint,integer,boolean,text,text) to service_role;
revoke all on function public.powerhub_reclaim_stale_sms_notifications(integer) from public,anon,authenticated;
grant execute on function public.powerhub_reclaim_stale_sms_notifications(integer) to service_role;
