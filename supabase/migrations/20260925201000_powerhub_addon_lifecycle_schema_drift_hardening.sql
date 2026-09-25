-- Hardening after production reconciliation:
-- 1) current package truth comes only from tenant_subscriptions (tenants.package_code does not exist in Production)
-- 2) normal renewal must never reactivate an archived tenant/subscription.

create or replace function public.powerhub_effective_tenant_quota(
  p_tenant_id bigint,
  p_resource text,
  p_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_package_code text;
  v_catalog jsonb;
  v_base integer:=0;
  v_override integer;
  v_delta integer:=0;
  v_overrides jsonb;
begin
  if p_resource not in ('subscribers','platformUser','fieldUser','branch') then
    raise exception 'INVALID_QUOTA_RESOURCE' using errcode='P0001';
  end if;

  select ts.package_code
    into v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.ends_at desc nulls last, ts.id desc
  limit 1;

  select p
    into v_catalog
  from jsonb_array_elements(
    coalesce(
      (select value->'packages'
       from public.platform_settings
       where setting_key='subscription_package_catalog' and is_enabled=true),
      '[]'::jsonb
    )
  ) p
  where p->>'code'=v_package_code
    and coalesce((p->>'active')::boolean,true)=true
  limit 1;

  v_base:=case p_resource
    when 'subscribers' then coalesce((v_catalog->>'includedSubscribers')::integer,0)
    when 'platformUser' then coalesce((v_catalog->>'platformUsers')::integer,0)
    when 'fieldUser' then coalesce((v_catalog->>'fieldUsers')::integer,0)
    when 'branch' then coalesce((v_catalog->>'branches')::integer,0)
  end;

  select coalesce(value->'overrides'->p_tenant_id::text,'{}'::jsonb)
    into v_overrides
  from public.platform_settings
  where setting_key='owner_limit_overrides';

  if p_resource='subscribers' then
    v_override:=case when (v_overrides->>'subscriberLimit')~'^\d+$' then (v_overrides->>'subscriberLimit')::integer end;
  elsif p_resource='platformUser' then
    v_override:=case when (v_overrides->>'subaccountLimit')~'^\d+$' then (v_overrides->>'subaccountLimit')::integer end;
  elsif p_resource='fieldUser' then
    v_override:=case when (v_overrides->>'fieldUserLimit')~'^\d+$' then (v_overrides->>'fieldUserLimit')::integer end;
  else
    v_override:=case when (v_overrides->>'branchLimit')~'^\d+$' then (v_overrides->>'branchLimit')::integer end;
  end if;

  v_base:=greatest(0,coalesce(v_override,v_base));

  select coalesce(sum(quantity * case
      when addon_code='subscribers50' and p_resource='subscribers' then 50
      else 1 end),0)::integer
    into v_delta
  from public.tenant_addon_requests
  where tenant_id=p_tenant_id
    and status='approved'
    and addon_code=case
      when p_resource='subscribers' then 'subscribers50'
      when p_resource='platformUser' then 'platformUser'
      when p_resource='fieldUser' then 'fieldUser'
      when p_resource='branch' then 'branch'
    end
    and (starts_at is null or starts_at<=p_at)
    and (ends_at is null or ends_at>p_at);

  return v_base + coalesce(v_delta,0);
end;
$$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz) from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz) to service_role;

create or replace function public.powerhub_admin_renew_subscription_with_addons(
 p_actor_user_id bigint,
 p_subscription_id bigint,
 p_new_ends_at timestamptz,
 p_addon_decisions jsonb default '[]'::jsonb
)
returns table(success boolean,ends_at timestamptz,renewed_addons integer,expired_addons integer)
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
 s public.tenant_subscriptions%rowtype;
 v_tenant_status text;
 d jsonb;
 a public.tenant_addon_requests%rowtype;
 v_renewed int:=0;
 v_expired int:=0;
 v_duration int;
 v_new_end timestamptz;
 v_actor_platform_role text;
begin
 select platform_role
   into v_actor_platform_role
 from public.users
 where id=p_actor_user_id
   and role='admin'
   and account_status='active'
   and platform_role in ('platform_owner','platform_admin');

 if v_actor_platform_role is null then
   raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
 end if;

 select * into s
 from public.tenant_subscriptions
 where id=p_subscription_id
 for update;

 if not found then
   raise exception 'SUBSCRIPTION_NOT_FOUND' using errcode='P0001';
 end if;

 select status into v_tenant_status
 from public.tenants
 where id=s.tenant_id;

 if v_tenant_status='archived' or s.status='archived' then
   raise exception 'ARCHIVED_SUBSCRIPTION_RENEWAL_FORBIDDEN' using errcode='42501';
 end if;

 if p_new_ends_at<=now() then
   raise exception 'INVALID_RENEWAL_END_DATE' using errcode='P0001';
 end if;

 update public.tenant_subscriptions
 set ends_at=p_new_ends_at,
     status='active',
     renewal_count=renewal_count+1,
     last_renewed_at=now(),
     updated_at=now()
 where id=s.id;

 for d in select * from jsonb_array_elements(coalesce(p_addon_decisions,'[]'::jsonb)) loop
   select * into a
   from public.tenant_addon_requests
   where id=(d->>'addonRequestId')::bigint
     and tenant_id=s.tenant_id
   for update;

   if not found or a.status<>'approved' then
     continue;
   end if;

   if coalesce(d->>'decision','expire')='renew' then
     v_duration:=coalesce(nullif(d->>'durationDays','')::int,a.duration_days,30);
     if v_duration<1 or v_duration>3650 then
       raise exception 'INVALID_ADDON_DURATION' using errcode='P0001';
     end if;

     v_new_end:=p_new_ends_at+make_interval(days=>v_duration);

     update public.tenant_addon_requests
     set ends_at=v_new_end,duration_days=v_duration
     where id=a.id;

     insert into public.tenant_addon_renewal_decisions(
       tenant_id,subscription_id,addon_request_id,decision,new_duration_days,created_by_user_id
     )
     values(s.tenant_id,s.id,a.id,'renew',v_duration,p_actor_user_id)
     on conflict(subscription_id,addon_request_id)
     do update set
       decision='renew',
       new_duration_days=excluded.new_duration_days,
       created_by_user_id=excluded.created_by_user_id,
       created_at=now();

     v_renewed:=v_renewed+1;
   else
     update public.tenant_addon_requests
     set ends_at=least(coalesce(ends_at,now()),now())
     where id=a.id;

     insert into public.tenant_addon_renewal_decisions(
       tenant_id,subscription_id,addon_request_id,decision,created_by_user_id
     )
     values(s.tenant_id,s.id,a.id,'expire',p_actor_user_id)
     on conflict(subscription_id,addon_request_id)
     do update set
       decision='expire',
       new_duration_days=null,
       created_by_user_id=excluded.created_by_user_id,
       created_at=now();

     v_expired:=v_expired+1;
   end if;
 end loop;

 insert into public.audit_logs(
   tenant_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
 )
 values(
   s.tenant_id,p_actor_user_id,v_actor_platform_role,'tenant_subscription',s.id::text,
   'renew_subscription_with_addons',
   jsonb_build_object(
     'newEndsAt',p_new_ends_at,
     'renewedAddons',v_renewed,
     'expiredAddons',v_expired
   )
 );

 return query select true,p_new_ends_at,v_renewed,v_expired;
end;
$$;

revoke all on function public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.powerhub_admin_renew_subscription_with_addons(bigint,bigint,timestamptz,jsonb) to service_role;
