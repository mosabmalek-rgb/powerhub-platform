-- SMS becomes a standalone prepaid wallet. Credits are permanent and independent of subscription expiry.
alter table public.tenant_sms_recharge_ledger add column if not exists note text;
alter table public.platform_sms_plans add column if not exists price_amount numeric(12,2) not null default 0,
 add column if not exists currency text not null default 'ILS';
alter table public.sms_package_requests add column if not exists sms_plan_id bigint references public.platform_sms_plans(id) on delete set null,
 add column if not exists requested_price numeric(12,2) not null default 0,
 add column if not exists currency text not null default 'ILS';

-- Freeze wallet usage accounting at cutover so historical/test SMS does not
-- silently consume newly funded wallet credit. For a queued legacy message that is
-- actually dispatched after cutover, count the provider-request start timestamp.
-- This keeps historical deliveries excluded without letting old pending rows bypass
-- the prepaid wallet or the provider-monthly limit when they are sent later.
create table if not exists public.tenant_sms_wallets (
 tenant_id bigint primary key references public.tenants(id) on delete cascade,
 accounting_started_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.tenant_sms_wallets enable row level security;
revoke all on table public.tenant_sms_wallets from public,anon,authenticated;
grant all on table public.tenant_sms_wallets to service_role;

insert into public.tenant_sms_wallets(tenant_id,accounting_started_at)
select t.id,now() from public.tenants t
on conflict(tenant_id) do nothing;

create or replace function public.powerhub_initialize_sms_wallet_accounting()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $function$
begin
 -- Existing tenants are seeded at cutover time above; new tenants start accounting
 -- from creation of their first subscription. ON CONFLICT preserves that first date
 -- across renewals, plan changes, and later subscription rows.
 insert into public.tenant_sms_wallets(tenant_id,accounting_started_at)
 values(new.tenant_id,coalesce(new.created_at,now())) on conflict(tenant_id) do nothing;
 return new;
end;
$function$;
revoke all on function public.powerhub_initialize_sms_wallet_accounting() from public,anon,authenticated;
drop trigger if exists powerhub_initialize_sms_wallet_accounting on public.tenants;
drop trigger if exists powerhub_initialize_sms_wallet_accounting on public.tenant_subscriptions;
create trigger powerhub_initialize_sms_wallet_accounting
 after insert on public.tenant_subscriptions
 for each row execute function public.powerhub_initialize_sms_wallet_accounting();

insert into public.tenant_sms_recharge_ledger(tenant_id,request_id,provider_mode,status,requested_messages,credited_messages,
 idempotency_key,requested_by_user_id,processed_by_user_id,confirmed_at,note,created_at,updated_at)
select r.tenant_id,r.id,'manual','manual_confirmed',greatest(r.requested_messages,coalesce(r.approved_messages,0)),r.approved_messages,
 gen_random_uuid(),r.requested_by_user_id,r.reviewed_by_user_id,coalesce(r.reviewed_at,r.updated_at,r.created_at),
 nullif(trim(coalesce(r.note,'')),''),coalesce(r.reviewed_at,r.created_at),now()
from public.sms_package_requests r where r.status='approved' and coalesce(r.approved_messages,0)>0
 and not exists(select 1 from public.tenant_sms_recharge_ledger l where l.request_id=r.id);

-- Repair a legacy state where an approved purchase already has a linked ledger
-- row but that row is still pending. Update the same row; never duplicate credit.
update public.tenant_sms_recharge_ledger l
set status='manual_confirmed',
    requested_messages=greatest(l.requested_messages,r.approved_messages),
    credited_messages=r.approved_messages,
    processed_by_user_id=coalesce(r.reviewed_by_user_id,l.processed_by_user_id),
    confirmed_at=coalesce(r.reviewed_at,r.updated_at,r.created_at,now()),
    failure_reason=null,
    updated_at=now()
from public.sms_package_requests r
where l.request_id=r.id
  and r.status='approved'
  and coalesce(r.approved_messages,0)>0
  and l.status='pending';

insert into public.platform_sms_plans(code,name,description,included_messages,price_amount,currency,is_active,created_at,updated_at)
select 'sms-'||((item->>'messages')::integer)::text,'حزمة '||((item->>'messages')::integer)::text||' رسالة',
 'منقولة من كتالوج الرسائل السابق.',(item->>'messages')::integer,greatest(coalesce(nullif(item->>'price','')::numeric,0),0),
 coalesce(nullif(s.value->>'currency',''),'ILS'),true,now(),now()
from public.platform_settings s cross join lateral jsonb_array_elements(coalesce(s.value->'smsAddons','[]'::jsonb)) item
where s.setting_key='subscription_package_catalog' and jsonb_typeof(s.value->'smsAddons')='array'
 and coalesce(item->>'messages','')~'^\d+$' and (item->>'messages')::integer>0
on conflict(code) do nothing;

update public.platform_settings s
set value=jsonb_set((s.value-'smsAddons'),'{packages}',
 coalesce((select jsonb_agg((pkg-'includedMessages'-'smsCost')
   ||case when jsonb_typeof(pkg->'features')='object' then jsonb_build_object('features',(pkg->'features')-'sms') else '{}'::jsonb end
   order by ord) from jsonb_array_elements(coalesce(s.value->'packages','[]'::jsonb)) with ordinality as x(pkg,ord)),'[]'::jsonb),true),
 updated_at=now()
where s.setting_key='subscription_package_catalog' and jsonb_typeof(s.value->'packages')='array';

update public.package_feature_policies set policy='addon',default_limit=0,limit_mode='fixed',policy_source='standalone_sms_wallet' where feature_key='sms';

insert into public.platform_settings(setting_key,is_enabled,value,message)
values('public_plan_visibility',true,'{"showPlans":true}'::jsonb,'التحكم الإداري في عرض باقات الاشتراك على الصفحة الرئيسية.')
on conflict(setting_key) do nothing;

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
  v_delta integer:=0;
begin
  if p_resource not in('subscribers','platformUser','fieldUser','branch','sms') then
    raise exception 'INVALID_QUOTA_RESOURCE' using errcode='P0001';
  end if;

  -- SMS is a prepaid, non-expiring wallet. Package quotas and monthly add-ons do not fund this balance.
  if p_resource='sms' then
    select coalesce(sum(l.credited_messages),0)::integer into v_base
    from public.tenant_sms_recharge_ledger l
    where l.tenant_id=p_tenant_id and l.status in ('provider_confirmed','manual_confirmed') and l.confirmed_at is not null;
    return v_base;
  end if;

  select ts.package_code into v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.ends_at desc nulls last,ts.id desc
  limit 1;

  select p into v_catalog
  from jsonb_array_elements(coalesce(
    (select value->'packages' from public.platform_settings
     where setting_key='subscription_package_catalog' and is_enabled=true),
    '[]'::jsonb
  )) p
  where p->>'code'=v_package_code
    and coalesce((p->>'active')::boolean,true)=true
  limit 1;

  v_base:=case p_resource
    when 'subscribers' then coalesce((v_catalog->>'includedSubscribers')::integer,0)
    when 'platformUser' then coalesce((v_catalog->>'platformUsers')::integer,0)
    when 'fieldUser' then coalesce((v_catalog->>'fieldUsers')::integer,0)
    when 'branch' then coalesce((v_catalog->>'branches')::integer,0)
    when 'sms' then coalesce((v_catalog->'features'->'sms'->>'limit')::integer,(v_catalog->>'includedMessages')::integer,0)
  end;

  select coalesce(sum(quantity*case when addon_code='subscribers50' and p_resource='subscribers' then 50 else 1 end),0)::integer
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

  if p_resource='sms' then
    select v_delta+coalesce(sum(l.credited_messages),0)::integer into v_delta
    from public.tenant_sms_recharge_ledger l
    where l.tenant_id=p_tenant_id
      and l.status in('provider_confirmed','manual_confirmed')
      and l.confirmed_at is not null
      and (l.request_id is null or exists(
        select 1 from public.sms_package_requests r
        join public.tenant_subscriptions ts on ts.id=r.subscription_id
        where r.id=l.request_id and ts.ends_at>p_at
      ));
  end if;

  return v_base+coalesce(v_delta,0);
end;
$function$;
;
revoke all on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz) from public,anon,authenticated;
grant execute on function public.powerhub_effective_tenant_quota(bigint,text,timestamptz) to service_role;

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
    select coalesce(sum(l.credited_messages),0)::integer as messages
    from public.tenant_sms_recharge_ledger l
    where p_feature_key='sms'
      and l.tenant_id=p_tenant_id
      and l.status in ('provider_confirmed','manual_confirmed')
      and l.confirmed_at is not null
  )
  select
    p_feature_key,
    pp.package_code,
    coalesce(pp.policy, 'not_included') as package_policy,
    coalesce((select is_active from feature), false)
      and (p_feature_key='sms' or coalesce(pp.policy in ('included','addon'), false)) as eligible,
    case
      when coalesce((select is_active from feature), false) = false then false
      when p_feature_key <> 'sms' and coalesce(pp.policy in ('included','addon'), false) = false then false
      when coalesce(c.status, 'inherit') = 'enabled' then true
      when coalesce(c.status, 'inherit') = 'disabled' then false
      else (p_feature_key='sms' or pp.policy = 'included')
        and p_feature_key not in ('subscriber_portal_logo','payment_documentation')
    end as enabled,
    case when p_feature_key='sms' then 0 else pp.default_limit end as package_limit,
    case
      when p_feature_key <> 'sms' and coalesce(c.limit_mode, 'inherit') = 'manual' then c.manual_limit
      when p_feature_key <> 'sms' and coalesce(c.limit_mode, 'inherit') = 'unlimited' then null
      when p_feature_key='sms' then public.powerhub_effective_tenant_quota(p_tenant_id,'sms')
      else pp.default_limit
    end as effective_limit,
    case
      when p_feature_key='sms' then 'wallet'
      when coalesce(c.limit_mode, 'inherit') = 'manual' then 'manual'
      when coalesce(c.limit_mode, 'inherit') = 'unlimited' then 'unlimited'
      else coalesce(pp.limit_mode, 'inherit')
    end as effective_limit_mode,
    coalesce(c.status, 'inherit') as control_status
  -- SMS uses the prepaid wallet even for a newly configured subscription
  -- package that has no legacy package_feature_policies row. Anchor the result
  -- so missing package/control rows do not make the feature policy disappear.
  from (select 1) as anchor
  left join package_policy pp on true
  left join control c on true;
$function$;
;
revoke all on function public.powerhub_resolve_tenant_feature_policy(bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_resolve_tenant_feature_policy(bigint,text) to service_role;

create or replace function public.powerhub_get_sms_quota(
 p_tenant_id bigint,p_period_start timestamptz default date_trunc('month',now())
)
returns table(subscription_id bigint,sms_plan_id bigint,plan_code text,plan_name text,base_messages bigint,
 additional_messages bigint,total_messages bigint,used_segments bigint,remaining_messages bigint)
language sql security definer set search_path='public','pg_temp'
as $function$
with subscription as (
 select ts.id,ts.sms_plan_id,lower(btrim(ts.package_code)) package_code
 from public.tenant_subscriptions ts where ts.tenant_id=p_tenant_id
 order by ts.created_at desc,ts.id desc limit 1
),
pkg as (
 select s.id subscription_id,s.sms_plan_id,s.package_code,coalesce(p->>'name',s.package_code) plan_name
 from subscription s left join public.platform_settings c on c.setting_key='subscription_package_catalog' and c.is_enabled
 left join lateral jsonb_array_elements(coalesce(c.value->'packages','[]'::jsonb)) p on p->>'code'=s.package_code
),
credits as (
 select coalesce(sum(l.credited_messages),0)::bigint total from public.tenant_sms_recharge_ledger l
 where l.tenant_id=p_tenant_id and l.status in('provider_confirmed','manual_confirmed') and l.confirmed_at is not null
),
usage as (
 select coalesce(sum(greatest(coalesce(m.segment_count,1),1)),0)::bigint used
 from public.notification_messages m
 left join public.tenant_sms_wallets w on w.tenant_id=m.tenant_id
 where m.tenant_id=p_tenant_id
  and coalesce(m.provider_request_started_at,m.created_at)>=coalesce(w.accounting_started_at,now())
  and m.channel='sms' and m.status in('processing','submitted','delivered','read','needs_review')
)
select pkg.subscription_id,pkg.sms_plan_id,pkg.package_code,pkg.plan_name,0::bigint,credits.total,credits.total,usage.used,
 greatest(credits.total-usage.used,0)
from (select 1) anchor
left join pkg on true
cross join credits
cross join usage;
$function$;
revoke all on function public.powerhub_get_sms_quota(bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.powerhub_get_sms_quota(bigint,timestamptz) to service_role;

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
  v_ledger public.tenant_sms_recharge_ledger%rowtype;
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


  if p_status='approved' and p_approved_messages>v_request.requested_messages then
    raise exception 'APPROVED_MESSAGES_EXCEED_REQUEST' using errcode='22023';
  end if;

  update public.sms_package_requests
  set status=p_status,approved_messages=case when p_status='approved' then p_approved_messages else 0 end,
      note=p_note,starts_at=null,ends_at=null,reviewed_by_user_id=p_actor_user_id,reviewed_at=now(),updated_at=now()
  where id=p_request_id;

  select * into v_ledger from public.tenant_sms_recharge_ledger where request_id=p_request_id for update;
  if not found then
    insert into public.tenant_sms_recharge_ledger(
      tenant_id,request_id,provider_mode,status,requested_messages,credited_messages,idempotency_key,
      requested_by_user_id,processed_by_user_id,confirmed_at,failure_reason,note
    ) values(
      v_request.tenant_id,p_request_id,'manual',case when p_status='approved' then 'manual_confirmed' else 'failed' end,
      v_request.requested_messages,case when p_status='approved' then p_approved_messages else 0 end,gen_random_uuid(),
      v_request.requested_by_user_id,p_actor_user_id,case when p_status='approved' then now() else null end,
      case when p_status='rejected' then coalesce(nullif(trim(p_note),''),'تم رفض طلب الحزمة من إدارة المنصة.') else null end,
      nullif(trim(coalesce(p_note,'')),'')
    );
  else
    if v_ledger.status in('provider_confirmed','manual_confirmed','failed','cancelled') then
      raise exception 'SMS_RECHARGE_ALREADY_FINALIZED' using errcode='55000';
    end if;
    update public.tenant_sms_recharge_ledger
    set status=case when p_status='approved' then 'manual_confirmed' else 'failed' end,
        requested_messages=case when p_status='approved' then greatest(requested_messages,p_approved_messages) else requested_messages end,
        credited_messages=case when p_status='approved' then p_approved_messages else 0 end,
        processed_by_user_id=p_actor_user_id,confirmed_at=case when p_status='approved' then now() else null end,
        failure_reason=case when p_status='rejected' then coalesce(nullif(trim(p_note),''),'تم رفض طلب الحزمة من إدارة المنصة.') else null end,
        note=nullif(trim(coalesce(p_note,'')),''),updated_at=now()
    where id=v_ledger.id;
  end if;

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
      'startsAt',null,
      'endsAt',null,
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
;
revoke all on function public.powerhub_admin_review_sms_package_request(bigint,bigint,text,integer,text) from public,anon,authenticated;
grant execute on function public.powerhub_admin_review_sms_package_request(bigint,bigint,text,integer,text) to service_role;

-- Deliberately no one-step SMS credit grant RPC is installed.
-- Manual recharges must use powerhub_admin_create_sms_recharge_request followed
-- by powerhub_admin_confirm_sms_recharge so the pending state is auditable.
create or replace function public.powerhub_admin_sms_wallet_summaries(p_actor_user_id bigint)
returns table(tenant_id bigint,tenant_name text,company_name text,owner_name text,total_credited bigint,used_segments bigint,
 remaining_messages bigint,provider_monthly_limit integer,provider_monthly_used bigint,last_recharge_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp
as $function$
begin
 if not exists(select 1 from public.users u where u.id=p_actor_user_id and u.role='admin'
  and u.account_status='active' and u.platform_role in('platform_owner','platform_admin')) then
  raise exception 'FORBIDDEN_PLATFORM_ROLE' using errcode='42501';
 end if;
 return query
 with credits as (
  select l.tenant_id,coalesce(sum(l.credited_messages),0)::bigint total,max(l.confirmed_at) last_at
  from public.tenant_sms_recharge_ledger l where l.status in('provider_confirmed','manual_confirmed') and l.confirmed_at is not null group by l.tenant_id
 ), all_usage as (
  select m.tenant_id,coalesce(sum(greatest(coalesce(m.segment_count,1),1)),0)::bigint used
  from public.notification_messages m
  left join public.tenant_sms_wallets w on w.tenant_id=m.tenant_id
  where m.channel='sms' and coalesce(m.provider_request_started_at,m.created_at)>=coalesce(w.accounting_started_at,now())
   and m.status in('processing','submitted','delivered','read','needs_review') group by m.tenant_id
 ), month_usage as (
  select m.tenant_id,coalesce(sum(greatest(coalesce(m.segment_count,1),1)),0)::bigint used
  from public.notification_messages m where m.channel='sms' and coalesce(m.provider_request_started_at,m.created_at)>=date_trunc('month',now())
   and m.status in('processing','submitted','delivered','read','needs_review') group by m.tenant_id
 )
 select t.id,t.name,coalesce(op.company_name,t.name),op.full_name,coalesce(c.total,0),coalesce(u.used,0),
  greatest(coalesce(c.total,0)-coalesce(u.used,0),0),a.monthly_limit,coalesce(mu.used,0),c.last_at
 from public.tenants t left join public.tenant_owner_profiles op on op.tenant_id=t.id
 left join credits c on c.tenant_id=t.id left join all_usage u on u.tenant_id=t.id
 left join month_usage mu on mu.tenant_id=t.id left join public.tenant_tweetsms_accounts a on a.tenant_id=t.id
 order by coalesce(op.company_name,t.name),t.id;
end;
$function$;
revoke all on function public.powerhub_admin_sms_wallet_summaries(bigint) from public,anon,authenticated;
grant execute on function public.powerhub_admin_sms_wallet_summaries(bigint) to service_role;

create or replace function public.powerhub_request_sms_package_plan(p_tenant_id bigint,p_site_id bigint,p_user_id bigint,p_sms_plan_id bigint,p_note text default null)
returns table(request_id bigint,request_status text,already_requested boolean)
language plpgsql security definer set search_path=public,pg_temp
as $function$
declare v_subscription_id bigint;v_plan public.platform_sms_plans%rowtype;v_request_id bigint;
begin
 if not exists(select 1 from public.tenant_members m where m.tenant_id=p_tenant_id and m.user_id=p_user_id
  and m.role='owner' and m.is_active and m.membership_status='active') then raise exception 'SMS_RECHARGE_OWNER_ONLY' using errcode='42501'; end if;
 if not exists(select 1 from public.sites s where s.id=p_site_id and s.tenant_id=p_tenant_id and s.status='active') then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;
 select ts.id into v_subscription_id from public.tenant_subscriptions ts where ts.tenant_id=p_tenant_id
  and ts.status in('trial','active') and (ts.ends_at is null or ts.ends_at>now()) order by ts.created_at desc,ts.id desc limit 1;
 if v_subscription_id is null then raise exception 'SMS_SUBSCRIPTION_REQUIRED' using errcode='P0001'; end if;
 perform pg_advisory_xact_lock(hashtextextended('powerhub_sms_package_request:'||p_tenant_id::text,62291));
 if exists(select 1 from public.sms_package_requests r where r.tenant_id=p_tenant_id and r.status='pending') then raise exception 'SMS_PACKAGE_REQUEST_PENDING' using errcode='P0001'; end if;
 select * into v_plan from public.platform_sms_plans p where p.id=p_sms_plan_id and p.is_active for share;
 if not found then raise exception 'SMS_PLAN_NOT_AVAILABLE' using errcode='P0001'; end if;
 if v_plan.included_messages<1 then raise exception 'INVALID_SMS_PACKAGE_QUANTITY' using errcode='P0001'; end if;
 insert into public.sms_package_requests(tenant_id,subscription_id,requested_by_user_id,requested_messages,note,sms_plan_id,requested_price,currency)
 values(p_tenant_id,v_subscription_id,p_user_id,v_plan.included_messages,nullif(trim(coalesce(p_note,'')),''),v_plan.id,v_plan.price_amount,v_plan.currency) returning id into v_request_id;
 insert into public.tenant_sms_recharge_ledger(tenant_id,request_id,provider_mode,status,requested_messages,credited_messages,idempotency_key,requested_by_user_id,note)
 values(p_tenant_id,v_request_id,'manual','pending',v_plan.included_messages,0,gen_random_uuid(),p_user_id,nullif(trim(coalesce(p_note,'')),''));
 insert into public.audit_logs(tenant_id,site_id,user_id,entity_type,entity_id,action,after_data)
 values(p_tenant_id,p_site_id,p_user_id,'sms_package_request',v_request_id::text,'sms_wallet_package_requested',
  jsonb_build_object('planId',v_plan.id,'planName',v_plan.name,'requestedMessages',v_plan.included_messages,'price',v_plan.price_amount,'currency',v_plan.currency));
 return query select v_request_id,'pending'::text,false;
end;
$function$;
revoke all on function public.powerhub_request_sms_package_plan(bigint,bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_request_sms_package_plan(bigint,bigint,bigint,bigint,text) to service_role;

CREATE OR REPLACE FUNCTION public.powerhub_claim_sms_notification(p_user_id bigint, p_notification_id bigint)
 RETURNS TABLE(notification_id bigint, tenant_id bigint, recipient text, rendered_text text, api_endpoint text, credential_ciphertext text, credential_iv text, sender_name text, attempt_number integer, character_count integer, segment_count integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_message public.notification_messages%rowtype;
  v_account public.tenant_tweetsms_accounts%rowtype;
  v_site_id bigint;
  v_is_platform_admin boolean;
  v_allowed boolean;
  v_used_segments integer;
  v_used_wallet_segments integer;
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

  select subscriber.site_id
  into v_site_id
  from public.subscribers as subscriber
  where subscriber.id = v_message.subscriber_id
    and subscriber.tenant_id = v_message.tenant_id;

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

  select account.*
  into v_account
  from public.tenant_tweetsms_accounts as account
  where account.tenant_id = v_message.tenant_id
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

  select coalesce(sum(greatest(coalesce(messages.segment_count,1),1)),0)::integer into v_used_wallet_segments
  from public.notification_messages messages
  left join public.tenant_sms_wallets sms_wallet on sms_wallet.tenant_id=messages.tenant_id
  where messages.tenant_id=v_message.tenant_id and messages.channel='sms' and messages.id<>v_message.id
   and coalesce(messages.provider_request_started_at,messages.created_at)>=coalesce(sms_wallet.accounting_started_at,now())
   and messages.status in('processing','submitted','delivered','read','needs_review');
  select coalesce(sum(greatest(coalesce(messages.segment_count,1),1)),0)::integer into v_used_segments
  from public.notification_messages messages
  where messages.tenant_id=v_message.tenant_id and messages.channel='sms' and messages.id<>v_message.id
   and coalesce(messages.provider_request_started_at,messages.created_at)>=date_trunc('month',now())
   and messages.status in('processing','submitted','delivered','read','needs_review');
  if v_feature_policy.effective_limit is null or v_used_wallet_segments+v_segment_count>v_feature_policy.effective_limit then
   raise exception 'SMS_WALLET_BALANCE_EXCEEDED' using errcode='P0001';
  end if;
  if v_account.monthly_limit is not null and v_used_segments+v_segment_count>v_account.monthly_limit then
   raise exception 'SMS_PROVIDER_MONTHLY_LIMIT_EXCEEDED' using errcode='P0001';
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
  update public.tenant_tweetsms_accounts as account
  set sms_dispatch_lease_notification_id = v_message.id,
      sms_dispatch_lease_until = now() + interval '10 minutes'
  where account.tenant_id = v_message.tenant_id;

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
      'walletTotalCredit',v_feature_policy.effective_limit,
      'walletUsedBeforeDispatch',v_used_wallet_segments,
      'providerMonthlyLimit',v_account.monthly_limit,
      'providerMonthlyUsedBeforeDispatch',v_used_segments,
      'limitMode',v_feature_policy.effective_limit_mode
    )
  );

  return next;
end;
$function$
;
;
revoke all on function public.powerhub_claim_sms_notification(bigint,bigint) from public,anon,authenticated;
grant execute on function public.powerhub_claim_sms_notification(bigint,bigint) to service_role;
