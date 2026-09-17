-- PowerHub: align privileged RPC identity checks with the canonical
-- active platform-admin contract used by the application layer.

create or replace function public.powerhub_admin_attach_owner_user(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_user_id bigint,
  p_site_id bigint default null
)
returns table(success boolean, site_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_platform_role text;
  v_user_role text;
  v_user_platform_role text;
  v_site_id bigint;
  v_previous_owners jsonb;
begin
  select u.platform_role into v_actor_platform_role
  from public.users u
  where u.id=p_actor_user_id
    and u.role='admin'
    and u.account_status='active'
    and u.platform_role in ('platform_owner','platform_admin','finance_admin');
  if v_actor_platform_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  select u.role,u.platform_role into v_user_role,v_user_platform_role
  from public.users u where u.id=p_user_id;
  if v_user_role is null then raise exception 'OWNER_USER_NOT_FOUND' using errcode='P0002'; end if;
  if v_user_role<>'user' or v_user_platform_role is not null then
    raise exception 'PLATFORM_ACCOUNT_CANNOT_BE_OWNER' using errcode='42501';
  end if;

  if p_site_id is not null then
    select s.id into v_site_id from public.sites s
    where s.id=p_site_id and s.tenant_id=p_tenant_id;
  else
    select s.id into v_site_id from public.sites s
    where s.tenant_id=p_tenant_id order by s.id limit 1;
  end if;
  if v_site_id is null then raise exception 'SITE_NOT_FOUND' using errcode='P0002'; end if;

  perform pg_advisory_xact_lock(p_tenant_id, hashtext('tenant-owner-transfer'));

  select coalesce(jsonb_agg(jsonb_build_object('userId',tm.user_id,'membershipId',tm.id)), '[]'::jsonb)
  into v_previous_owners
  from public.tenant_members tm
  where tm.tenant_id=p_tenant_id and tm.role='owner' and tm.user_id<>p_user_id;

  update public.tenant_members
  set role='member', updated_at=now()
  where tenant_id=p_tenant_id and role='owner' and user_id<>p_user_id;

  update public.staff_profiles
  set is_active=false, updated_at=now()
  where tenant_id=p_tenant_id and user_id<>p_user_id and role='owner';

  insert into public.tenant_members(tenant_id,user_id,role,is_active,membership_status,updated_at)
  values(p_tenant_id,p_user_id,'owner',true,'active',now())
  on conflict(tenant_id,user_id) do update set role='owner',is_active=true,membership_status='active',expires_at=null,updated_at=now();

  insert into public.staff_profiles(tenant_id,site_id,user_id,role,is_active,updated_at)
  values(p_tenant_id,v_site_id,p_user_id,'owner',true,now())
  on conflict(user_id,site_id,role) do update set is_active=true,updated_at=now();

  update public.tenant_owner_profiles
  set owner_user_id=p_user_id,claimed_at=now(),updated_at=now()
  where tenant_id=p_tenant_id;

  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,metadata)
  values(p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,'tenant_owner_profile',p_tenant_id::text,'platform_admin_attach_owner_user',
    jsonb_build_object('attachedUserId',p_user_id,'previousOwners',v_previous_owners,'ownershipTransferred',true));

  return query select true,v_site_id;
end;
$$;

revoke execute on function public.powerhub_admin_attach_owner_user(bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_admin_attach_owner_user(bigint,bigint,bigint,bigint) to service_role;

create or replace function public.powerhub_admin_update_subscription(
  p_actor_user_id bigint,
  p_tenant_id bigint,
  p_plan text,
  p_status text,
  p_billing_cycle text,
  p_ends_at timestamptz,
  p_auto_renew boolean,
  p_notes text default null,
  p_sms_plan_id bigint default null
)
returns table(success boolean, subscription_id bigint, site_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor_platform_role text; v_subscription_id bigint; v_site_id bigint; v_sms_plan_active boolean;
begin
 select u.platform_role into v_actor_platform_role
 from public.users u
 where u.id=p_actor_user_id
   and u.role='admin'
   and u.account_status='active'
   and u.platform_role in ('platform_owner','platform_admin','finance_admin');
 if v_actor_platform_role is null then raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501'; end if;
 if p_plan not in ('starter','professional','enterprise') then raise exception 'INVALID_SUBSCRIPTION_PLAN' using errcode='22023'; end if;
 if p_status not in ('trial','active','overdue','suspended','cancelled') then raise exception 'INVALID_SUBSCRIPTION_STATUS' using errcode='22023'; end if;
 if p_billing_cycle not in ('monthly','yearly') then raise exception 'INVALID_BILLING_CYCLE' using errcode='22023'; end if;
 if p_sms_plan_id is not null then
   select sp.is_active into v_sms_plan_active from public.platform_sms_plans sp where sp.id=p_sms_plan_id;
   if coalesce(v_sms_plan_active,false)=false then raise exception 'SMS_PLAN_NOT_ACTIVE' using errcode='22023'; end if;
 end if;
 select ts.id,s.id into v_subscription_id,v_site_id
 from public.tenant_subscriptions ts
 left join lateral(select id from public.sites where tenant_id=p_tenant_id order by id limit 1)s on true
 where ts.tenant_id=p_tenant_id limit 1;
 if v_subscription_id is null or v_site_id is null then raise exception 'SUBSCRIPTION_OR_SITE_NOT_FOUND' using errcode='P0002'; end if;
 update public.tenant_subscriptions set plan=p_plan,status=p_status,billing_cycle=p_billing_cycle,ends_at=p_ends_at,auto_renew=p_auto_renew,notes=p_notes,sms_plan_id=p_sms_plan_id,updated_at=now() where id=v_subscription_id;
 update public.tenants set plan=p_plan,status=case when p_status in ('suspended','cancelled') then 'suspended' else 'active' end,updated_at=now() where id=p_tenant_id;
 insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data) values(p_tenant_id,v_site_id,p_actor_user_id,v_actor_platform_role,'tenant_subscription',v_subscription_id::text,'platform_admin_update_subscription',jsonb_build_object('plan',p_plan,'status',p_status,'billingCycle',p_billing_cycle,'endsAt',p_ends_at,'autoRenew',p_auto_renew,'smsPlanId',p_sms_plan_id));
 return query select true,v_subscription_id,v_site_id;
end;
$$;

revoke execute on function public.powerhub_admin_update_subscription(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint) from public, anon, authenticated;
grant execute on function public.powerhub_admin_update_subscription(bigint,bigint,text,text,text,timestamptz,boolean,text,bigint) to service_role;
