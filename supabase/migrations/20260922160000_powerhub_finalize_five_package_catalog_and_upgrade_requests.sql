-- Finalize the approved five-package commercial catalog and make upgrade requests package-code based.

-- 1) Authoritative commercial catalog.
insert into public.platform_settings (setting_key,is_enabled,value,message)
values (
  'subscription_package_catalog',
  true,
  jsonb_build_object(
    'currency','ILS',
    'version',2,
    'packages',jsonb_build_array(
      jsonb_build_object('code','basic','name','الناشئة','price',123,'includedMessages',600,'platformUsers',2,'fieldUsers',1,'branches',1,'includedSubscribers',150,'active',true),
      jsonb_build_object('code','advanced','name','النمو','price',234,'includedMessages',1200,'platformUsers',2,'fieldUsers',2,'branches',1,'includedSubscribers',300,'active',true),
      jsonb_build_object('code','professional','name','الاحتراف','price',345,'includedMessages',2000,'platformUsers',3,'fieldUsers',3,'branches',1,'includedSubscribers',500,'active',true),
      jsonb_build_object('code','business','name','الأعمال','price',456,'includedMessages',3000,'platformUsers',3,'fieldUsers',4,'branches',1,'includedSubscribers',750,'active',true),
      jsonb_build_object('code','vip','name','الذهبية-VIP','price',567,'includedMessages',4000,'platformUsers',4,'fieldUsers',4,'branches',2,'includedSubscribers',900,'active',true)
    ),
    'addons',jsonb_build_object(
      'fieldUser',jsonb_build_object('name','مستخدم ميداني إضافي','price',10,'unit','user','max',null),
      'platformUser',jsonb_build_object('name','مستخدم منصة إضافي','price',10,'unit','user','max',null),
      'branch',jsonb_build_object('name','فرع إضافي','price',20,'unit','branch','max',null),
      'subscribers50',jsonb_build_object('name','50 مشترك إضافي','price',20,'unit','subscriber_bundle','quantity',50,'maxBundles',2)
    ),
    'smsAddons',jsonb_build_array(
      jsonb_build_object('messages',500,'price',55),
      jsonb_build_object('messages',1000,'price',100),
      jsonb_build_object('messages',5000,'price',450),
      jsonb_build_object('messages',10000,'price',850)
    )
  ),
  'الكتالوج التجاري المعتمد للباقات الخمس.'
)
on conflict (setting_key) do update set
  is_enabled=excluded.is_enabled,
  value=excluded.value,
  message=excluded.message,
  updated_at=now();

update public.platform_settings
set value='{"limits":{"basic":150,"advanced":300,"professional":500,"business":750,"vip":900}}'::jsonb,
    is_enabled=true,
    message='حدود المشتركين حسب الباقات الخمس.'
where setting_key='owner_subscriber_limits';

update public.platform_settings
set value='{"limits":{"basic":2,"advanced":2,"professional":3,"business":3,"vip":4}}'::jsonb,
    is_enabled=true,
    message='حدود حسابات المنصة حسب الباقات الخمس.'
where setting_key='owner_subaccount_limits';

update public.platform_settings
set value='{"limits":{"basic":1,"advanced":1,"professional":1,"business":1,"vip":2}}'::jsonb,
    is_enabled=true,
    message='حدود الأفرع حسب الباقات الخمس.'
where setting_key='owner_branch_limits';

-- 2) Upgrade-request storage: rename legacy plan columns to package-code columns.
do $$
declare r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid='public.subscription_upgrade_requests'::regclass
      and contype='c'
      and pg_get_constraintdef(oid) ~ '(current_plan|requested_plan)'
  loop
    execute format('alter table public.subscription_upgrade_requests drop constraint %I',r.conname);
  end loop;
end $$;

alter table public.subscription_upgrade_requests
  rename column current_plan to current_package_code;
alter table public.subscription_upgrade_requests
  rename column requested_plan to requested_package_code;

update public.subscription_upgrade_requests
set current_package_code=case current_package_code
  when 'starter' then 'basic'
  when 'enterprise' then 'business'
  else current_package_code
end,
requested_package_code=case requested_package_code
  when 'starter' then 'basic'
  when 'enterprise' then 'business'
  else requested_package_code
end;

alter table public.subscription_upgrade_requests
  add constraint subscription_upgrade_requests_current_package_code_check
  check (current_package_code in ('basic','advanced','professional','business','vip'));

alter table public.subscription_upgrade_requests
  add constraint subscription_upgrade_requests_requested_package_code_check
  check (requested_package_code in ('basic','advanced','professional','business','vip'));

-- 3) Canonical owner request RPC.
drop function if exists public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text);

create function public.powerhub_request_subscription_upgrade(
  p_tenant_id bigint,
  p_site_id bigint,
  p_user_id bigint,
  p_requested_package_code text
)
returns table(request_id bigint, requested_package_code text, already_requested boolean)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_current_package_code text;
  v_limit_policy jsonb;
  v_overrides_policy jsonb;
  v_override jsonb;
  v_limit integer;
  v_count integer;
  v_existing_id bigint;
  v_existing_package text;
  v_role text;
begin
  if p_requested_package_code not in ('basic','advanced','professional','business','vip') then
    raise exception 'INVALID_REQUESTED_PACKAGE_CODE' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id,hashtext('subscription-upgrade'));

  perform 1 from public.sites
  where id=p_site_id and tenant_id=p_tenant_id and status <> 'archived'
  for share;
  if not found then raise exception 'SITE_OUT_OF_SCOPE' using errcode='P0001'; end if;

  select coalesce(ts.package_code,t.package_code)
  into v_current_package_code
  from public.tenants t
  left join public.tenant_subscriptions ts on ts.tenant_id=t.id
  where t.id=p_tenant_id
  for share;

  if v_current_package_code is null then
    raise exception 'TENANT_PACKAGE_NOT_FOUND' using errcode='P0001';
  end if;

  if (case p_requested_package_code when 'basic' then 1 when 'advanced' then 2 when 'professional' then 3 when 'business' then 4 when 'vip' then 5 end)
     <=
     (case v_current_package_code when 'basic' then 1 when 'advanced' then 2 when 'professional' then 3 when 'business' then 4 when 'vip' then 5 end)
  then
    raise exception 'REQUESTED_PACKAGE_NOT_HIGHER' using errcode='P0001';
  end if;

  select value into v_limit_policy from public.platform_settings where setting_key='owner_subscriber_limits';
  select value into v_overrides_policy from public.platform_settings where setting_key='owner_limit_overrides';
  v_override:=case when jsonb_typeof(v_overrides_policy->'overrides')='object'
    then v_overrides_policy->'overrides'->p_tenant_id::text else null end;

  v_limit:=coalesce((v_limit_policy->'limits'->>v_current_package_code)::integer,
    case v_current_package_code when 'basic' then 150 when 'advanced' then 300 when 'professional' then 500 when 'business' then 750 when 'vip' then 900 end);

  if (v_override->>'subscriberLimit') ~ '^\d+$'
     and (v_override->>'subscriberLimit')::integer between 0 and 100000
  then v_limit:=(v_override->>'subscriberLimit')::integer;
  end if;

  select count(*)::integer into v_count from public.subscribers where tenant_id=p_tenant_id;
  if v_count < v_limit then
    raise exception 'SUBSCRIBER_LIMIT_NOT_REACHED' using errcode='P0001';
  end if;

  select id,requested_package_code
  into v_existing_id,v_existing_package
  from public.subscription_upgrade_requests
  where tenant_id=p_tenant_id and status='pending'
  order by created_at desc limit 1 for share;

  if found then return query select v_existing_id,v_existing_package,true; return; end if;

  insert into public.subscription_upgrade_requests(
    tenant_id,requested_by_user_id,current_package_code,requested_package_code,reason,status
  ) values (
    p_tenant_id,p_user_id,v_current_package_code,p_requested_package_code,'subscriber_limit_reached','pending'
  ) returning id into v_existing_id;

  select platform_role into v_role from public.users where id=p_user_id;

  insert into public.audit_logs(
    tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data
  ) values (
    p_tenant_id,p_site_id,p_user_id,v_role,'subscription_upgrade_request',v_existing_id::text,'request_upgrade',
    jsonb_build_object(
      'currentPackageCode',v_current_package_code,
      'requestedPackageCode',p_requested_package_code,
      'reason','subscriber_limit_reached',
      'subscriberCount',v_count,
      'subscriberLimit',v_limit
    )
  );

  return query select v_existing_id,p_requested_package_code,false;
end;
$$;

revoke execute on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.powerhub_request_subscription_upgrade(bigint,bigint,bigint,text) to service_role;

-- 4) Keep the historical admin listing RPC shape compatible while exposing package codes.
drop function if exists public.powerhub_admin_subscription_upgrade_requests();

create function public.powerhub_admin_subscription_upgrade_requests()
returns table(
  id bigint,
  tenant_id bigint,
  current_package_code text,
  requested_package_code text,
  status text,
  note text,
  created_at timestamptz,
  reviewed_at timestamptz,
  tenant_name text,
  owner_name text,
  owner_email text
)
language sql
security definer
set search_path=public,pg_temp
as $$
  select r.id,r.tenant_id,r.current_package_code,r.requested_package_code,r.status,r.note,
         r.created_at,r.reviewed_at,t.name,op.full_name,op.email
  from public.subscription_upgrade_requests r
  join public.tenants t on t.id=r.tenant_id
  left join public.tenant_owner_profiles op on op.tenant_id=r.tenant_id
  order by r.created_at desc
  limit 300
$$;

revoke all on function public.powerhub_admin_subscription_upgrade_requests() from public,anon,authenticated;
grant execute on function public.powerhub_admin_subscription_upgrade_requests() to service_role;
