-- Extend owner upgrade requests to quota-based operational features.
-- Requests remain owner-initiated; platform admins may override individual limits instead.
create or replace function public.powerhub_request_subscription_upgrade(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_requested_package_code text
)
returns table(request_id bigint, requested_package_code text, already_requested boolean)
language plpgsql security invoker set search_path=public,pg_temp
as $$
declare
  v_current_package_code text;
  v_limit_policy jsonb;
  v_overrides_policy jsonb;
  v_override jsonb;
  v_existing_id bigint;
  v_existing_package text;
  v_reason text;
  v_current_rank int;
  v_requested_rank int;
  v_limit int;
  v_count int;
begin
  if p_requested_package_code not in ('basic','advanced','professional','business','vip') then
    raise exception 'INVALID_REQUESTED_PACKAGE_CODE' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(p_tenant_id,hashtext('subscription-upgrade'));
  if not exists(select 1 from public.sites where id=p_site_id and tenant_id=p_tenant_id and status<>'archived') then
    raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
  end if;
  select coalesce(ts.package_code,t.package_code) into v_current_package_code
  from public.tenants t left join public.tenant_subscriptions ts on ts.tenant_id=t.id
  where t.id=p_tenant_id for share;
  if v_current_package_code is null then raise exception 'TENANT_PACKAGE_NOT_FOUND' using errcode='P0001'; end if;
  v_current_rank:=case v_current_package_code when 'basic' then 1 when 'advanced' then 2 when 'professional' then 3 when 'business' then 4 when 'vip' then 5 else 0 end;
  v_requested_rank:=case p_requested_package_code when 'basic' then 1 when 'advanced' then 2 when 'professional' then 3 when 'business' then 4 when 'vip' then 5 else 0 end;
  if v_requested_rank<=v_current_rank then raise exception 'REQUESTED_PACKAGE_NOT_HIGHER' using errcode='P0001'; end if;

  select value into v_limit_policy from public.platform_settings where setting_key='owner_subscriber_limits';
  select value into v_overrides_policy from public.platform_settings where setting_key='owner_limit_overrides';
  v_override:=case when jsonb_typeof(v_overrides_policy->'overrides')='object' then v_overrides_policy->'overrides'->p_tenant_id::text else '{}'::jsonb end;

  v_reason:='manual_upgrade_request';
  -- A request is allowed when the owner reaches any quota-based operational limit:
  -- subscribers, active platform subaccounts, active field users, or branches.
  v_limit:=coalesce((v_limit_policy->'limits'->>v_current_package_code)::int,
    case v_current_package_code when 'basic' then 150 when 'advanced' then 300 when 'professional' then 500 when 'business' then 750 else 900 end);
  if (v_override->>'subscriberLimit')~'^\d+$' then v_limit:=(v_override->>'subscriberLimit')::int; end if;
  select count(*)::int into v_count from public.subscribers where tenant_id=p_tenant_id;
  if v_count>=v_limit then v_reason:='subscriber_limit_reached'; end if;

  if v_reason='manual_upgrade_request' then
    v_limit:=case v_current_package_code when 'basic' then 2 when 'advanced' then 2 when 'professional' then 3 when 'business' then 3 else 4 end;
    if (v_override->>'subaccountLimit')~'^\d+$' then v_limit:=(v_override->>'subaccountLimit')::int; end if;
    select count(*)::int into v_count from public.tenant_members where tenant_id=p_tenant_id and role='member' and is_active=true and membership_status='active';
    if v_count>=v_limit then v_reason:='subaccount_limit_reached'; end if;
  end if;

  if v_reason='manual_upgrade_request' then
    v_limit:=case v_current_package_code when 'basic' then 1 when 'advanced' then 2 when 'professional' then 3 when 'business' then 4 else 4 end;
    if (v_override->>'fieldUserLimit')~'^\d+$' then v_limit:=(v_override->>'fieldUserLimit')::int; end if;
    select count(*)::int into v_count from public.staff_profiles sp
    where sp.tenant_id=p_tenant_id and sp.role='technician' and sp.is_active=true and (
      sp.permissions @> '["accessFieldApp"]'::jsonb or sp.permissions @> '["recordReadings"]'::jsonb
    );
    if v_count>=v_limit then v_reason:='field_user_limit_reached'; end if;
  end if;

  if v_reason='manual_upgrade_request' then
    v_limit:=case v_current_package_code when 'vip' then 2 else 1 end;
    if (v_override->>'branchLimit')~'^\d+$' then v_limit:=(v_override->>'branchLimit')::int; end if;
    select count(*)::int into v_count from public.sites where tenant_id=p_tenant_id and status<>'archived';
    if v_count>=v_limit then v_reason:='branch_limit_reached'; end if;
  end if;

  if v_reason='manual_upgrade_request' then
    raise exception 'NO_QUOTA_LIMIT_REACHED' using errcode='P0001';
  end if;

  select id,requested_package_code into v_existing_id,v_existing_package
  from public.subscription_upgrade_requests
  where tenant_id=p_tenant_id and status='pending'
  order by created_at desc limit 1 for share;
  if found then return query select v_existing_id,v_existing_package,true; return; end if;

  insert into public.subscription_upgrade_requests(
    tenant_id,requested_by_user_id,current_package_code,requested_package_code,reason,status
  ) values(p_tenant_id,p_user_id,v_current_package_code,p_requested_package_code,v_reason,'pending')
  returning id into v_existing_id;

  return query select v_existing_id,p_requested_package_code,false;
end;
$$;

revoke execute on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) to service_role;
