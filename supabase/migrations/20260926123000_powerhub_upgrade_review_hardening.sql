-- Harden subscription-upgrade approval:
-- 1) lock and update only the current subscription row;
-- 2) revalidate that the requested package is still strictly above the current package;
-- 3) keep tenant.package_code and tenant_subscriptions.package_code synchronized;
-- 4) audit the actual before/after package values.

create or replace function public.powerhub_admin_review_subscription_upgrade_request(
  p_actor_user_id bigint,
  p_request_id bigint,
  p_decision text,
  p_note text default null
)
returns table(success boolean, package_code text, replayed boolean)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_actor_platform_role text;
  v_request public.subscription_upgrade_requests%rowtype;
  v_subscription public.tenant_subscriptions%rowtype;
  v_site_id bigint;
  v_current_rank integer;
  v_requested_rank integer;
begin
  select platform_role
    into v_actor_platform_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in('platform_owner','platform_admin');

  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  if p_decision not in('approved','rejected') then
    raise exception 'INVALID_DECISION' using errcode='22023';
  end if;

  select *
    into v_request
  from public.subscription_upgrade_requests
  where id=p_request_id
  for update;

  if not found then
    raise exception 'REQUEST_NOT_FOUND' using errcode='P0002';
  end if;

  if v_request.status not in('pending','reviewing') then
    if (p_decision='approved' and v_request.status='approved')
       or (p_decision='rejected' and v_request.status='rejected')
    then
      return query
        select true,
          case when p_decision='approved' then v_request.requested_package_code else v_request.current_package_code end,
          true;
      return;
    end if;
    raise exception 'REQUEST_ALREADY_PROCESSED' using errcode='P0001';
  end if;

  select s.id
    into v_site_id
  from public.sites s
  where s.tenant_id=v_request.tenant_id
    and s.status<>'archived'
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode='P0002';
  end if;

  select *
    into v_subscription
  from public.tenant_subscriptions
  where tenant_id=v_request.tenant_id
  order by
    case when status in('active','trial') then 0 else 1 end,
    ends_at desc nulls last,
    id desc
  limit 1
  for update;

  if not found then
    raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0002';
  end if;

  if p_decision='approved' then
    v_current_rank := case v_subscription.package_code
      when 'basic' then 1
      when 'advanced' then 2
      when 'professional' then 3
      when 'business' then 4
      when 'vip' then 5
      else null
    end;
    v_requested_rank := case v_request.requested_package_code
      when 'basic' then 1
      when 'advanced' then 2
      when 'professional' then 3
      when 'business' then 4
      when 'vip' then 5
      else null
    end;

    if v_requested_rank is null or v_current_rank is null or v_requested_rank<=v_current_rank then
      raise exception 'REQUESTED_PACKAGE_NO_LONGER_UPGRADE' using errcode='P0001';
    end if;
  end if;

  update public.subscription_upgrade_requests
  set status=p_decision,
      note=p_note,
      reviewed_by_user_id=p_actor_user_id,
      reviewed_at=now(),
      updated_at=now()
  where id=v_request.id;

  if p_decision='approved' then
    update public.tenant_subscriptions
    set package_code=v_request.requested_package_code,
        updated_at=now()
    where id=v_subscription.id;

    update public.tenants
    set package_code=v_request.requested_package_code,
        updated_at=now()
    where id=v_request.tenant_id;

    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,
      entity_type,entity_id,action,before_data,after_data
    )
    values(
      v_request.tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
      'tenant_subscription',v_subscription.id::text,
      'platform_admin_approved_subscription_upgrade',
      jsonb_build_object('packageCode',v_subscription.package_code),
      jsonb_build_object('packageCode',v_request.requested_package_code,'requestId',v_request.id)
    );
  else
    insert into public.audit_logs(
      tenant_id,site_id,user_id,actor_platform_role,
      entity_type,entity_id,action,before_data,after_data
    )
    values(
      v_request.tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,
      'subscription_upgrade_request',v_request.id::text,
      'platform_admin_rejected_subscription_upgrade',
      jsonb_build_object('requestedPackageCode',v_request.requested_package_code,'currentPackageCode',v_request.current_package_code),
      jsonb_build_object('decision','rejected','note',p_note)
    );
  end if;

  return query
    select true,
      case when p_decision='approved' then v_request.requested_package_code else v_request.current_package_code end,
      false;
end;
$$;

revoke all on function public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text)
  from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_subscription_upgrade_request(bigint,bigint,text,text)
  to service_role;
