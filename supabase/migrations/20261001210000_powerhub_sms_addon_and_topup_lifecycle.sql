-- SMS entitlement lifecycle:
-- 1) package monthly allocation remains the base;
-- 2) the existing tenant addon system supplies renewable SMS add-ons;
-- 3) sms_package_requests supplies one-off non-renewing top-ups;
-- 4) all SMS sending/quota enforcement uses the same effective limit.

alter table public.sms_package_requests
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz;

create index if not exists sms_package_requests_active_period_idx
  on public.sms_package_requests(tenant_id, status, starts_at, ends_at);

alter table public.tenant_addon_requests
  drop constraint if exists tenant_addon_requests_quantity_check;

alter table public.tenant_addon_requests
  add constraint tenant_addon_requests_quantity_check
  check (
    quantity > 0
    and quantity <= case when addon_code = 'sms' then 10000000 else 1000 end
  );

-- SMS is a first-class effective quota resource.
create or replace function public.powerhub_effective_tenant_quota(
  p_tenant_id bigint,
  p_resource text,
  p_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_package_code text;
  v_catalog jsonb;
  v_base integer:=0;
  v_override integer;
  v_delta integer:=0;
  v_overrides jsonb;
begin
  if p_resource not in ('subscribers','platformUser','fieldUser','branch','sms') then
    raise exception 'INVALID_QUOTA_RESOURCE' using errcode='P0001';
  end if;

  select coalesce(ts.package_code,t.package_code) into v_package_code
  from public.tenants t
  left join public.tenant_subscriptions ts on ts.tenant_id=t.id
  where t.id=p_tenant_id;

  select p into v_catalog
  from jsonb_array_elements(
    coalesce(
      (select value->'packages'
       from public.platform_settings
       where setting_key='subscription_package_catalog'
         and is_enabled=true),
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
    when 'sms' then coalesce(
      (v_catalog->'features'->'sms'->>'limit')::integer,
      (v_catalog->>'includedMessages')::integer,
      0
    )
  end;

  if p_resource <> 'sms' then
    select coalesce(value->'overrides'->p_tenant_id::text,'{}'::jsonb) into v_overrides
    from public.platform_settings
    where setting_key='owner_limit_overrides';

    if p_resource='subscribers' then
      v_override:=case when (v_overrides->>'subscriberLimit')~'^\\d+$' then (v_overrides->>'subscriberLimit')::integer end;
    elsif p_resource='platformUser' then
      v_override:=case when (v_overrides->>'subaccountLimit')~'^\\d+$' then (v_overrides->>'subaccountLimit')::integer end;
    elsif p_resource='fieldUser' then
      v_override:=case when (v_overrides->>'fieldUserLimit')~'^\\d+$' then (v_overrides->>'fieldUserLimit')::integer end;
    else
      v_override:=case when (v_overrides->>'branchLimit')~'^\\d+$' then (v_overrides->>'branchLimit')::integer end;
    end if;

    v_base:=greatest(0,coalesce(v_override,v_base));
  end if;

  select coalesce(
    sum(
      quantity * case
        when addon_code='subscribers50' and p_resource='subscribers' then 50
        else 1
      end
    ),
    0
  )::integer
  into v_delta
  from public.tenant_addon_requests
  where tenant_id=p_tenant_id
    and status='approved'
    and addon_code=case
      when p_resource='subscribers' then 'subscribers50'
      when p_resource='platformUser' then 'platformUser'
      when p_resource='fieldUser' then 'fieldUser'
      when p_resource='branch' then 'branch'
      when p_resource='sms' then 'sms'
    end
    and (starts_at is null or starts_at<=p_at)
    and (ends_at is null or ends_at>p_at);

  return v_base + coalesce(v_delta,0);
end;
$function$;

revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz)
  to service_role;

-- Make the feature-control authority include active SMS add-ons and one-off approved top-ups.
create or replace function public.powerhub_resolve_tenant_feature_policy(
  p_tenant_id bigint,
  p_feature_key text
)
returns table(
  feature_key text,
  package_code text,
  package_policy text,
  eligible boolean,
  enabled boolean,
  package_limit integer,
  effective_limit integer,
  effective_limit_mode text,
  control_status text
)
language sql
stable
security invoker
set search_path=public,pg_temp
as $function$
  with subscription as (
    select ts.package_code
    from public.tenant_subscriptions ts
    where ts.tenant_id = p_tenant_id
      and ts.status in ('trial','active')
      and (ts.ends_at is null or ts.ends_at > now())
    order by ts.created_at desc
    limit 1
  ),
  feature as (
    select fc.is_active
    from public.feature_catalog fc
    where fc.feature_key = p_feature_key
    limit 1
  ),
  package_policy as (
    select p.package_code, p.policy, p.default_limit, p.limit_mode
    from public.package_feature_policies p
    where p.package_code = (select package_code from subscription)
      and p.feature_key = p_feature_key
  ),
  control as (
    select c.status, c.limit_mode, c.manual_limit
    from public.tenant_feature_controls c
    where c.tenant_id = p_tenant_id
      and c.feature_key = p_feature_key
  ),
  sms_addons as (
    select coalesce(sum(a.quantity),0)::integer as messages
    from public.tenant_addon_requests a
    where p_feature_key='sms'
      and a.tenant_id=p_tenant_id
      and a.addon_code='sms'
      and a.status='approved'
      and (a.starts_at is null or a.starts_at<=now())
      and (a.ends_at is null or a.ends_at>now())
  ),
  sms_topups as (
    select coalesce(sum(r.approved_messages),0)::integer as messages
    from public.sms_package_requests r
    where p_feature_key='sms'
      and r.tenant_id=p_tenant_id
      and r.status='approved'
      and (
        (r.starts_at is not null
          and r.starts_at<=now()
          and (r.ends_at is null or r.ends_at>now()))
        or
        (r.starts_at is null
          and r.reviewed_at>=date_trunc('month',now())
          and r.reviewed_at<date_trunc('month',now())+interval '1 month')
      )
  )
  select
    p_feature_key,
    pp.package_code,
    coalesce(pp.policy, 'not_included') as package_policy,
    coalesce((select is_active from feature), false)
      and coalesce(pp.policy in ('included','addon'), false) as eligible,
    case
      when coalesce((select is_active from feature), false) = false then false
      when coalesce(pp.policy in ('included','addon'), false) = false then false
      when coalesce(c.status, 'inherit') = 'enabled' then true
      when coalesce(c.status, 'inherit') = 'disabled' then false
      else pp.policy = 'included'
        and p_feature_key not in ('subscriber_portal_logo','payment_documentation')
    end as enabled,
    pp.default_limit as package_limit,
    case
      when coalesce(c.limit_mode, 'inherit') = 'manual' then c.manual_limit
      when coalesce(c.limit_mode, 'inherit') = 'unlimited' then null
      when p_feature_key='sms'
        then pp.default_limit
          + coalesce((select messages from sms_addons),0)
          + coalesce((select messages from sms_topups),0)
      else pp.default_limit
    end as effective_limit,
    case
      when coalesce(c.limit_mode, 'inherit') = 'manual' then 'manual'
      when coalesce(c.limit_mode, 'inherit') = 'unlimited' then 'unlimited'
      else coalesce(pp.limit_mode, 'inherit')
    end as effective_limit_mode,
    coalesce(c.status, 'inherit') as control_status
  from package_policy pp
  full join control c on true;
$function$;

revoke all on function public.powerhub_resolve_tenant_feature_policy(bigint,text)
  from public,anon,authenticated;
grant execute on function public.powerhub_resolve_tenant_feature_policy(bigint,text)
  to service_role;

-- SMS quota read model: package base + active renewable SMS add-ons + one-off top-ups.
create or replace function public.powerhub_get_sms_quota(
  p_tenant_id bigint,
  p_period_start timestamptz default date_trunc('month',now())
)
returns table(
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
set search_path='public','pg_temp'
as $function$
with current_subscription as (
  select ts.id, ts.sms_plan_id, lower(btrim(ts.package_code)) package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.created_at desc,ts.id desc
  limit 1
),
package as (
  select
    cs.id subscription_id,
    cs.sms_plan_id,
    cs.package_code,
    coalesce(pkg->>'name',cs.package_code) plan_name,
    coalesce(
      (pkg->'features'->'sms'->>'limit')::bigint,
      (pkg->>'includedMessages')::bigint,
      0
    ) base_messages
  from current_subscription cs
  left join public.platform_settings s
    on s.setting_key='subscription_package_catalog'
   and s.is_enabled=true
  left join lateral jsonb_array_elements(
    coalesce(s.value->'packages','[]'::jsonb)
  ) pkg on pkg->>'code'=cs.package_code
        and coalesce((pkg->>'active')::boolean,true)=true
),
sms_addons as (
  select coalesce(sum(a.quantity),0)::bigint additional_messages
  from public.tenant_addon_requests a
  where a.tenant_id=p_tenant_id
    and a.addon_code='sms'
    and a.status='approved'
    and (a.starts_at is null or a.starts_at<=now())
    and (a.ends_at is null or a.ends_at>now())
),
sms_topups as (
  select coalesce(sum(r.approved_messages),0)::bigint additional_messages
  from public.sms_package_requests r
  where r.tenant_id=p_tenant_id
    and r.status='approved'
    and (
      (r.starts_at is not null
        and r.starts_at<=now()
        and (r.ends_at is null or r.ends_at>now()))
      or
      (r.starts_at is null
        and r.reviewed_at>=p_period_start
        and r.reviewed_at<p_period_start+interval '1 month')
    )
),
extras as (
  select
    (select additional_messages from sms_addons)
    + (select additional_messages from sms_topups) as additional_messages
),
usage as (
  select coalesce(sum(greatest(coalesce(m.segment_count,1),1)),0)::bigint used_segments
  from public.notification_messages m
  where m.tenant_id=p_tenant_id
    and m.channel='sms'
    and m.created_at>=p_period_start
    and m.status in('processing','submitted','delivered','read','needs_review')
)
select
  package.subscription_id,
  package.sms_plan_id,
  package.package_code,
  package.plan_name,
  package.base_messages,
  extras.additional_messages,
  package.base_messages+extras.additional_messages,
  usage.used_segments,
  greatest(package.base_messages+extras.additional_messages-usage.used_segments,0)
from package cross join extras cross join usage;
$function$;

revoke all on function public.powerhub_get_sms_quota(bigint,timestamptz)
  from public,anon,authenticated;
grant execute on function public.powerhub_get_sms_quota(bigint,timestamptz)
  to service_role;

-- Approving a one-off SMS top-up makes it valid only through the current subscription end.
create or replace function public.powerhub_admin_review_sms_package_request(
  p_actor_user_id bigint,
  p_request_id bigint,
  p_status text,
  p_approved_messages integer,
  p_note text default null
)
returns table(
  success boolean,
  tenant_id bigint,
  site_id bigint,
  status text,
  approved_messages integer,
  replayed boolean
)
language plpgsql
security definer
set search_path='public','pg_temp'
as $function$
declare
  v_role text;
  v_request public.sms_package_requests%rowtype;
  v_site_id bigint;
  v_subscription_end timestamptz;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
begin
  select platform_role into v_role
  from public.users
  where id=p_actor_user_id
    and role='admin'
    and account_status='active'
    and platform_role in('platform_owner','platform_admin');

  if v_role is null then
    raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
  end if;

  if p_status not in('approved','rejected') then
    raise exception 'INVALID_STATUS' using errcode='22023';
  end if;

  if p_approved_messages<0 then
    raise exception 'INVALID_APPROVED_MESSAGES' using errcode='22023';
  end if;

  if p_status='approved' and p_approved_messages<1 then
    raise exception 'APPROVED_MESSAGES_REQUIRED' using errcode='22023';
  end if;

  select * into v_request
  from public.sms_package_requests
  where id=p_request_id
  for update;

  if not found then
    raise exception 'REQUEST_NOT_FOUND' using errcode='P0002';
  end if;

  if v_request.status<>'pending' then
    if v_request.status=p_status
       and (p_status='rejected' or coalesce(v_request.approved_messages,0)=p_approved_messages) then
      select s.id into v_site_id
      from public.sites s
      where s.tenant_id=v_request.tenant_id
      order by s.id
      limit 1;

      if v_site_id is null then
        raise exception 'SITE_NOT_FOUND' using errcode='P0002';
      end if;

      return query
      select true,v_request.tenant_id,v_site_id,p_status,
        case when p_status='approved' then p_approved_messages else 0 end,
        true;
      return;
    end if;

    raise exception 'REQUEST_ALREADY_PROCESSED' using errcode='55000';
  end if;

  select s.id into v_site_id
  from public.sites s
  where s.tenant_id=v_request.tenant_id
  order by s.id
  limit 1;

  if v_site_id is null then
    raise exception 'SITE_NOT_FOUND' using errcode='P0002';
  end if;

  if p_status='approved' then
    select ts.ends_at into v_subscription_end
    from public.tenant_subscriptions ts
    where ts.tenant_id=v_request.tenant_id
    order by ts.created_at desc,ts.id desc
    limit 1;

    if v_subscription_end is null or v_subscription_end<=now() then
      raise exception 'SMS_SUBSCRIPTION_EXPIRED' using errcode='P0001';
    end if;

    v_starts_at:=now();
    v_ends_at:=v_subscription_end;
  end if;

  update public.sms_package_requests
  set status=p_status,
      approved_messages=case when p_status='approved' then p_approved_messages else 0 end,
      note=p_note,
      starts_at=case when p_status='approved' then v_starts_at else null end,
      ends_at=case when p_status='approved' then v_ends_at else null end,
      reviewed_by_user_id=p_actor_user_id,
      reviewed_at=now(),
      updated_at=now()
  where id=p_request_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,before_data,after_data
  )
  values(
    v_request.tenant_id,
    v_site_id,
    p_actor_user_id,
    v_role,
    'sms_package_request',
    p_request_id::text,
    case
      when p_status='approved' then 'platform_admin_approved_sms_topup'
      else 'platform_admin_rejected_sms_topup'
    end,
    jsonb_build_object(
      'status',v_request.status,
      'approvedMessages',v_request.approved_messages,
      'startsAt',v_request.starts_at,
      'endsAt',v_request.ends_at
    ),
    jsonb_build_object(
      'status',p_status,
      'approvedMessages',case when p_status='approved' then p_approved_messages else 0 end,
      'startsAt',v_starts_at,
      'endsAt',v_ends_at,
      'note',p_note
    )
  );

  return query
  select true,
    v_request.tenant_id,
    v_site_id,
    p_status,
    case when p_status='approved' then p_approved_messages else 0 end,
    false;
end;
$function$;

revoke all on function public.powerhub_admin_review_sms_package_request(bigint,bigint,text,integer,text)
  from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_sms_package_request(bigint,bigint,text,integer,text)
  to service_role;

-- SMS add-ons are aligned to the subscription end date when approved.
create or replace function public.powerhub_admin_review_tenant_addon_request(
 p_actor_user_id bigint,
 p_request_id bigint,
 p_decision text,
 p_note text default null,
 p_duration_days integer default null
)
returns table(success boolean,status text,ends_at timestamptz)
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
 r public.tenant_addon_requests%rowtype;
 v_days int;
 v_start timestamptz;
 v_end timestamptz;
 v_actor_platform_role text;
 v_subscription_end timestamptz;
begin
 select platform_role into v_actor_platform_role
 from public.users
 where id=p_actor_user_id
   and role='admin'
   and account_status='active'
   and platform_role in ('platform_owner','platform_admin');

 if v_actor_platform_role is null then
   raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
 end if;

 if p_decision not in ('approved','rejected') then
   raise exception 'INVALID_DECISION' using errcode='P0001';
 end if;

 select * into r
 from public.tenant_addon_requests
 where id=p_request_id
 for update;

 if not found then
   raise exception 'ADDON_REQUEST_NOT_FOUND' using errcode='P0001';
 end if;

 if r.status not in ('pending','reviewing') then
   raise exception 'ADDON_REQUEST_NOT_PENDING' using errcode='P0001';
 end if;

 if p_decision='rejected' then
   update public.tenant_addon_requests
   set status='rejected',reviewed_at=now(),reviewed_by_user_id=p_actor_user_id,review_note=p_note
   where id=r.id;

   return query select true,'rejected',null::timestamptz;
   return;
 end if;

 v_start:=now();

 if r.addon_code='sms' then
   select ts.ends_at into v_subscription_end
   from public.tenant_subscriptions ts
   where ts.tenant_id=r.tenant_id
   order by ts.created_at desc,ts.id desc
   limit 1;

   if v_subscription_end is null or v_subscription_end<=now() then
     raise exception 'SMS_SUBSCRIPTION_EXPIRED' using errcode='P0001';
   end if;

   v_end:=v_subscription_end;
   v_days:=greatest(1,ceil(extract(epoch from (v_end-v_start))/86400.0)::integer);
 else
   v_days:=coalesce(p_duration_days,r.duration_days,30);

   if v_days<1 or v_days>3650 then
     raise exception 'INVALID_ADDON_DURATION' using errcode='P0001';
   end if;

   v_end:=v_start+make_interval(days=>v_days);
 end if;

 update public.tenant_addon_requests
 set status='approved',
     duration_days=v_days,
     starts_at=v_start,
     ends_at=v_end,
     reviewed_at=now(),
     reviewed_by_user_id=p_actor_user_id,
     review_note=p_note
 where id=r.id;

 insert into public.audit_logs(
   tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
 )
 values(
   r.tenant_id,r.site_id,p_actor_user_id,v_actor_platform_role,
   'tenant_addon_request',r.id::text,'approve_addon',
   jsonb_build_object(
     'addonCode',r.addon_code,
     'quantity',r.quantity,
     'durationDays',v_days,
     'startsAt',v_start,
     'endsAt',v_end
   )
 );

 return query select true,'approved',v_end;
end;
$function$;

revoke all on function public.powerhub_admin_review_tenant_addon_request(bigint,bigint,text,text,integer)
  from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_tenant_addon_request(bigint,bigint,text,text,integer)
  to service_role;

-- SMS add-ons always terminate with the tenant subscription.
-- This also protects the existing idempotent renewal RPC: when it extends an
-- approved SMS add-on, the trigger forces the add-on end to the new subscription end.
create or replace function public.powerhub_sync_sms_addon_end_to_subscription()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
declare
  v_subscription_end timestamptz;
begin
  if new.addon_code <> 'sms' or new.status <> 'approved' then
    return new;
  end if;

  select ts.ends_at
    into v_subscription_end
  from public.tenant_subscriptions ts
  where ts.tenant_id=new.tenant_id
  order by ts.ends_at desc nulls last, ts.id desc
  limit 1;

  if v_subscription_end is not null then
    new.ends_at := v_subscription_end;
    new.duration_days := greatest(
      1,
      ceil(extract(epoch from (v_subscription_end-coalesce(new.starts_at,now())))/86400.0)::integer
    );
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_powerhub_sync_sms_addon_end on public.tenant_addon_requests;
create trigger trg_powerhub_sync_sms_addon_end
before insert or update of status,starts_at,ends_at,duration_days
on public.tenant_addon_requests
for each row
execute function public.powerhub_sync_sms_addon_end_to_subscription();

revoke all on function public.powerhub_sync_sms_addon_end_to_subscription()
  from public,anon,authenticated;
grant execute on function public.powerhub_sync_sms_addon_end_to_subscription()
  to service_role;

-- Recreate the SMS add-on request contract with a higher quantity ceiling than user/branch add-ons.
create or replace function public.powerhub_request_tenant_addon(
 p_tenant_id bigint,
 p_site_id bigint,
 p_user_id bigint,
 p_addon_code text,
 p_quantity integer default 1,
 p_note text default null
)
returns table(request_id bigint,addon_code text,quantity integer,already_requested boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $function$
declare
 v_existing_id bigint;
 v_existing_qty integer;
begin
 if p_addon_code not in ('fieldUser','platformUser','subscribers50','branch','sms') then
   raise exception 'INVALID_ADDON_CODE' using errcode='P0001';
 end if;

 if p_quantity is null
    or p_quantity<1
    or p_quantity>case when p_addon_code='sms' then 10000000 else 1000 end then
   raise exception 'INVALID_ADDON_QUANTITY' using errcode='P0001';
 end if;

 if not exists(
   select 1
   from public.tenant_members
   where tenant_id=p_tenant_id
     and user_id=p_user_id
     and role='owner'
     and is_active=true
     and membership_status='active'
 ) then
   raise exception 'ADDON_REQUEST_OWNER_ONLY' using errcode='42501';
 end if;

 if p_site_id is not null and not exists(
   select 1
   from public.sites
   where id=p_site_id
     and tenant_id=p_tenant_id
     and status<>'archived'
 ) then
   raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001';
 end if;

 select id,quantity into v_existing_id,v_existing_qty
 from public.tenant_addon_requests
 where tenant_id=p_tenant_id
   and addon_code=p_addon_code
   and status in ('pending','reviewing')
 order by created_at desc
 limit 1
 for update;

 if found then
   return query select v_existing_id,p_addon_code,v_existing_qty,true;
   return;
 end if;

 insert into public.tenant_addon_requests(
   tenant_id,site_id,requested_by_user_id,addon_code,quantity,note
 )
 values(
   p_tenant_id,p_site_id,p_user_id,p_addon_code,p_quantity,p_note
 )
 returning id into v_existing_id;

 insert into public.audit_logs(
   tenant_id,site_id,user_id,entity_type,entity_id,action,after_data
 )
 values(
   p_tenant_id,p_site_id,p_user_id,
   'tenant_addon_request',v_existing_id::text,'request_addon',
   jsonb_build_object(
     'addonCode',p_addon_code,
     'quantity',p_quantity,
     'note',p_note
   )
 );

 return query select v_existing_id,p_addon_code,p_quantity,false;
end;
$function$;

revoke all on function public.powerhub_request_tenant_addon(bigint,bigint,bigint,text,integer,text)
  from public,anon,authenticated;
grant execute on function public.powerhub_request_tenant_addon(bigint,bigint,bigint,text,integer,text)
  to service_role;
