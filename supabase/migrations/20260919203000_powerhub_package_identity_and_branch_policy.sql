-- PowerHub package identity + branch policy contract
-- Five commercial packages are authoritative for new runtime behavior.
-- Legacy plan remains for compatibility only.

alter table public.tenant_subscriptions
  add column if not exists package_code text;

update public.tenant_subscriptions
set package_code = case plan
  when 'starter' then 'basic'
  when 'professional' then 'advanced'
  when 'enterprise' then 'business'
  else package_code
end
where package_code is null or btrim(package_code) = '';

alter table public.tenant_subscriptions
  drop constraint if exists tenant_subscriptions_package_code_check;

alter table public.tenant_subscriptions
  add constraint tenant_subscriptions_package_code_check
  check (package_code is null or package_code in ('basic','advanced','professional','business','vip'));

update public.platform_settings
set
  is_enabled = true,
  value = jsonb_build_object(
    'packageLimits', jsonb_build_object(
      'basic', 1,
      'advanced', 1,
      'professional', 1,
      'business', 1,
      'vip', 2
    ),
    'legacyFallback', jsonb_build_object(
      'starter', 1,
      'professional', 1,
      'enterprise', 1
    )
  ),
  message = 'سياسة الأفرع حسب الباقة: الباقات الأساسية الأربع فرع واحد، وVIP فرعان.'
where setting_key = 'branch_feature';

insert into public.platform_settings(setting_key,is_enabled,value,message)
select
  'branch_feature',
  true,
  jsonb_build_object(
    'packageLimits', jsonb_build_object(
      'basic', 1,
      'advanced', 1,
      'professional', 1,
      'business', 1,
      'vip', 2
    ),
    'legacyFallback', jsonb_build_object(
      'starter', 1,
      'professional', 1,
      'enterprise', 1
    )
  ),
  'سياسة الأفرع حسب الباقة: الباقات الأساسية الأربع فرع واحد، وVIP فرعان.'
where not exists (
  select 1 from public.platform_settings where setting_key = 'branch_feature'
);

update public.platform_settings
set
  is_enabled = true,
  value = jsonb_build_object(
    'currency','ILS',
    'version',2,
    'packages', jsonb_build_array(
      jsonb_build_object('code','basic','name','الناشئة','active',true,'subscribersLimitMode','maximum','includedSubscribers',150,'price',123,'smsCost',51,'serviceNet',72,'includedMessages',600,'fieldUsers',1,'platformUsers',2,'branches',1,'logoPolicy','not_included','logoAddonPrice',null,'supportLevel','standard','legacyPlan','starter'),
      jsonb_build_object('code','advanced','name','النمو','active',true,'subscribersLimitMode','maximum','includedSubscribers',300,'price',234,'smsCost',102,'serviceNet',132,'includedMessages',1200,'fieldUsers',2,'platformUsers',2,'branches',1,'logoPolicy','addon','logoAddonPrice',20,'supportLevel','standard','legacyPlan','professional'),
      jsonb_build_object('code','professional','name','الاحتراف','active',true,'subscribersLimitMode','maximum','includedSubscribers',500,'price',345,'smsCost',170,'serviceNet',175,'includedMessages',2000,'fieldUsers',3,'platformUsers',3,'branches',1,'logoPolicy','addon','logoAddonPrice',20,'supportLevel','priority','legacyPlan','professional'),
      jsonb_build_object('code','business','name','الأعمال','active',true,'subscribersLimitMode','maximum','includedSubscribers',750,'price',456,'smsCost',255,'serviceNet',201,'includedMessages',3000,'fieldUsers',4,'platformUsers',3,'branches',1,'logoPolicy','included','logoAddonPrice',0,'supportLevel','priority_plus','legacyPlan','enterprise'),
      jsonb_build_object('code','vip','name','الذهبية / VIP','active',true,'subscribersLimitMode','minimum','includedSubscribers',900,'price',567,'smsCost',340,'serviceNet',227,'includedMessages',4000,'fieldUsers',4,'platformUsers',4,'branches',2,'logoPolicy','included','logoAddonPrice',0,'supportLevel','highest_plus','legacyPlan','enterprise')
    ),
    'addons', jsonb_build_object(
      'branch',jsonb_build_object('name','فرع إضافي','unit','branch','price',20),
      'fieldUser',jsonb_build_object('name','مستخدم ميداني إضافي','unit','user','price',10),
      'platformUser',jsonb_build_object('name','مستخدم منصة إضافي','unit','user','price',10)
    ),
    'smsAddons', jsonb_build_array()
  ),
  message = 'الكتالوج التجاري المعتمد لباقات PowerHub الخمس.'
where setting_key = 'subscription_package_catalog';

insert into public.platform_settings(setting_key,is_enabled,value,message)
select
  'subscription_package_catalog',
  true,
  jsonb_build_object(
    'currency','ILS','version',2,
    'packages',jsonb_build_array(
      jsonb_build_object('code','basic','name','الناشئة','active',true,'subscribersLimitMode','maximum','includedSubscribers',150,'price',123,'smsCost',51,'serviceNet',72,'includedMessages',600,'fieldUsers',1,'platformUsers',2,'branches',1,'logoPolicy','not_included','logoAddonPrice',null,'supportLevel','standard','legacyPlan','starter'),
      jsonb_build_object('code','advanced','name','النمو','active',true,'subscribersLimitMode','maximum','includedSubscribers',300,'price',234,'smsCost',102,'serviceNet',132,'includedMessages',1200,'fieldUsers',2,'platformUsers',2,'branches',1,'logoPolicy','addon','logoAddonPrice',20,'supportLevel','standard','legacyPlan','professional'),
      jsonb_build_object('code','professional','name','الاحتراف','active',true,'subscribersLimitMode','maximum','includedSubscribers',500,'price',345,'smsCost',170,'serviceNet',175,'includedMessages',2000,'fieldUsers',3,'platformUsers',3,'branches',1,'logoPolicy','addon','logoAddonPrice',20,'supportLevel','priority','legacyPlan','professional'),
      jsonb_build_object('code','business','name','الأعمال','active',true,'subscribersLimitMode','maximum','includedSubscribers',750,'price',456,'smsCost',255,'serviceNet',201,'includedMessages',3000,'fieldUsers',4,'platformUsers',3,'branches',1,'logoPolicy','included','logoAddonPrice',0,'supportLevel','priority_plus','legacyPlan','enterprise'),
      jsonb_build_object('code','vip','name','الذهبية / VIP','active',true,'subscribersLimitMode','minimum','includedSubscribers',900,'price',567,'smsCost',340,'serviceNet',227,'includedMessages',4000,'fieldUsers',4,'platformUsers',4,'branches',2,'logoPolicy','included','logoAddonPrice',0,'supportLevel','highest_plus','legacyPlan','enterprise')
    ),
    'addons',jsonb_build_object(
      'branch',jsonb_build_object('name','فرع إضافي','unit','branch','price',20),
      'fieldUser',jsonb_build_object('name','مستخدم ميداني إضافي','unit','user','price',10),
      'platformUser',jsonb_build_object('name','مستخدم منصة إضافي','unit','user','price',10)
    ),
    'smsAddons',jsonb_build_array()
  ),
  'الكتالوج التجاري المعتمد لباقات PowerHub الخمس.'
where not exists (
  select 1 from public.platform_settings where setting_key = 'subscription_package_catalog'
);

create index if not exists idx_tenant_subscriptions_package_code
  on public.tenant_subscriptions(package_code);

comment on column public.tenant_subscriptions.package_code is
  'Authoritative PowerHub commercial package identity; plan is retained as legacy compatibility.';


create or replace function public.powerhub_create_site(p_tenant_id bigint,p_user_id bigint,p_name text,p_code text,p_city text default null,p_address text default null)
returns table (site_id bigint)
language plpgsql
security invoker
set search_path=public,pg_temp
as $$
declare
  v_plan text;
  v_package_code text;
  v_setting public.platform_settings%rowtype;
  v_tenant_setting public.tenant_branch_settings%rowtype;
  v_limit int;
  v_configured_limit int;
  v_count int;
  v_enabled boolean;
  v_site_id bigint;
  v_role text;
begin
  if p_name is null or char_length(btrim(p_name)) < 2 or p_code is null or char_length(btrim(p_code)) < 2 then
    raise exception 'INVALID_SITE_INPUT' using errcode='P0001';
  end if;

  perform pg_advisory_xact_lock(p_tenant_id,hashtext('branch-policy'));

  select ts.plan, ts.package_code
    into v_plan, v_package_code
  from public.tenant_subscriptions ts
  where ts.tenant_id=p_tenant_id
  order by ts.created_at desc, ts.id desc
  limit 1;

  v_plan:=coalesce(v_plan,'starter');
  v_package_code:=lower(nullif(btrim(v_package_code),''));

  select * into v_setting
  from public.platform_settings
  where setting_key='branch_feature'
  limit 1;

  select * into v_tenant_setting
  from public.tenant_branch_settings
  where tenant_id=p_tenant_id
  limit 1;

  v_limit:=case when v_package_code='vip' then 2 else 1 end;

  v_configured_limit := nullif(v_setting.value->'packageLimits'->>v_package_code,'')::int;
  if v_configured_limit is not null and v_configured_limit >= 1 and v_configured_limit <= 1000 then
    v_limit:=v_configured_limit;
  else
    v_configured_limit := nullif(v_setting.value->'legacyFallback'->>v_plan,'')::int;
    if v_configured_limit is not null and v_configured_limit >= 1 and v_configured_limit <= 1000 then
      v_limit:=v_configured_limit;
    end if;
  end if;

  if v_tenant_setting.max_branches_override is not null and v_tenant_setting.max_branches_override >= 1 then
    v_limit:=v_tenant_setting.max_branches_override;
  end if;

  v_enabled:=coalesce(v_tenant_setting.is_enabled_override,coalesce(v_setting.is_enabled,false));
  if not v_enabled then
    raise exception 'BRANCH_FEATURE_DISABLED' using errcode='P0001';
  end if;

  select count(*)::int into v_count
  from public.sites
  where tenant_id=p_tenant_id and status<>'archived';

  if v_count>=v_limit then
    raise exception 'BRANCH_LIMIT_REACHED' using errcode='P0001';
  end if;

  insert into public.sites(tenant_id,name,code,city,address)
  values(p_tenant_id,btrim(p_name),btrim(p_code),nullif(btrim(p_city),''),nullif(btrim(p_address),''))
  returning id into v_site_id;

  insert into public.site_portal_settings(tenant_id,site_id,portal_code,display_name)
  values(p_tenant_id,v_site_id,lower(btrim(p_code)),btrim(p_name));

  select platform_role into v_role from public.users where id=p_user_id;

  insert into public.audit_logs(tenant_id,site_id,user_id,actor_platform_role,entity_type,entity_id,action,after_data)
  values(
    p_tenant_id,v_site_id,p_user_id,v_role,'site',v_site_id::text,'create',
    jsonb_build_object('name',p_name,'code',p_code,'city',p_city,'address',p_address,'packageCode',v_package_code,'branchLimit',v_limit)
  );

  return query select v_site_id;
end;
$$;

revoke execute on function public.powerhub_create_site(bigint,bigint,text,text,text,text) from public,anon,authenticated;
grant execute on function public.powerhub_create_site(bigint,bigint,text,text,text,text) to service_role;
