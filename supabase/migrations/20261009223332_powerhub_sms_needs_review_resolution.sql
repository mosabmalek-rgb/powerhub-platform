-- PowerHub: explicit resolution for uncertain SMS delivery outcomes.
-- A needs_review notification can only be resolved by an authorized tenant actor.
-- It must never be re-queued blindly because the provider may already have accepted it.

create or replace function public.powerhub_resolve_sms_needs_review(
  p_user_id bigint,
  p_notification_id bigint,
  p_resolution text,
  p_reason text default null
)
returns table(
  notification_id bigint,
  status text,
  provider_message_id text,
  attempts integer
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_message public.notification_messages%rowtype;
  v_site_id bigint;
  v_allowed boolean;
begin
  if p_resolution not in ('submitted','failed') then
    raise exception 'INVALID_SMS_REVIEW_RESOLUTION' using errcode='22023';
  end if;

  select *
    into v_message
  from public.notification_messages
  where id = p_notification_id
  for update;

  if not found then
    raise exception 'NOTIFICATION_NOT_FOUND' using errcode='P0001';
  end if;

  if v_message.channel <> 'sms' or v_message.status <> 'needs_review' then
    raise exception 'NOTIFICATION_REVIEW_REQUIRED' using errcode='P0001';
  end if;

  select site_id
    into v_site_id
  from public.subscribers
  where id = v_message.subscriber_id
    and tenant_id = v_message.tenant_id;

  if v_site_id is null then
    raise exception 'NOTIFICATION_SUBSCRIBER_SCOPE_REQUIRED' using errcode='P0001';
  end if;

  select
    exists(
      select 1
      from public.users u
      where u.id = p_user_id
        and u.account_status = 'active'
        and u.platform_role in ('platform_owner','platform_admin')
    )
    or exists(
      select 1
      from public.tenant_members m
      join public.staff_profiles s
        on s.user_id = m.user_id
       and s.tenant_id = m.tenant_id
       and s.site_id = v_site_id
      left join public.custom_permission_roles r
        on r.id = s.custom_role_id
       and r.tenant_id = s.tenant_id
       and r.is_active = true
      where m.tenant_id = v_message.tenant_id
        and m.user_id = p_user_id
        and m.is_active
        and m.membership_status = 'active'
        and s.is_active
        and (s.suspension_ends_at is null or s.suspension_ends_at <= now())
        and (s.role in ('owner','manager','accountant') or coalesce(s.permissions,r.permissions,'[]'::jsonb) ? 'manageMessaging')
    )
    into v_allowed;

  if not v_allowed then
    raise exception 'MESSAGING_PERMISSION_REQUIRED' using errcode='P0001';
  end if;

  update public.notification_messages
  set status = p_resolution,
      last_error = case
        when p_resolution = 'submitted' then null
        else coalesce(nullif(left(trim(coalesce(p_reason,'')),2000),''),'تم تأكيد فشل التسليم بعد المراجعة.')
      end,
      updated_at = now()
  where id = v_message.id
  returning id,status,provider_message_id,attempts
  into notification_id,status,provider_message_id,attempts;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata
  )
  values(
    v_message.tenant_id,
    v_site_id,
    p_user_id,
    (select platform_role from public.users where id=p_user_id),
    'notification_message',
    notification_id::text,
    'sms_needs_review_resolved',
    jsonb_build_object(
      'resolution', p_resolution,
      'reasonProvided', p_reason is not null and trim(p_reason) <> ''
    )
  );

  return next;
end;
$function$;

revoke all on function public.powerhub_resolve_sms_needs_review(bigint,bigint,text,text)
  from public, anon, authenticated;
grant execute on function public.powerhub_resolve_sms_needs_review(bigint,bigint,text,text)
  to service_role;
