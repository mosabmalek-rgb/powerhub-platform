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
