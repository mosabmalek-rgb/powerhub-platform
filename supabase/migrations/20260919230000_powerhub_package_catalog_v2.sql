-- PowerHub commercial package catalog v2.
-- The five package codes below are the authoritative commercial contract.
insert into public.platform_settings(setting_key,is_enabled,value,message)
values (
  'subscription_package_catalog',
  true,
  jsonb_build_object(
    'version', 3,
    'currency', 'ILS',
    'packages', jsonb_build_array(
      jsonb_build_object('code','basic','name','الناشئة','price',123,'active',true,'smsCost',51,'serviceNet',72,'includedMessages',600,'includedSubscribers',150,'subscribersLimitMode','maximum','fieldUsers',1,'platformUsers',2,'branches',1,'legacyPlan','starter','logoPolicy','not_included','logoAddonPrice',null,'subscriberLimitMode','maximum','supportLevel','standard','features',jsonb_build_object('subscribers',jsonb_build_object('limit',150,'mode','maximum'),'sms',jsonb_build_object('limit',600),'fieldUsers',jsonb_build_object('limit',1),'platformUsers',jsonb_build_object('limit',2),'branches',jsonb_build_object('limit',1),'logo',jsonb_build_object('enabled',false,'included',false,'addonPrice',0),'support',jsonb_build_object('level','standard'))),
      jsonb_build_object('code','advanced','name','النمو','price',234,'active',true,'smsCost',102,'serviceNet',132,'includedMessages',1200,'includedSubscribers',300,'subscribersLimitMode','maximum','fieldUsers',2,'platformUsers',2,'branches',1,'legacyPlan','professional','logoPolicy','addon','logoAddonPrice',20,'subscriberLimitMode','maximum','supportLevel','standard','features',jsonb_build_object('subscribers',jsonb_build_object('limit',300,'mode','maximum'),'sms',jsonb_build_object('limit',1200),'fieldUsers',jsonb_build_object('limit',2),'platformUsers',jsonb_build_object('limit',2),'branches',jsonb_build_object('limit',1),'logo',jsonb_build_object('enabled',true,'included',false,'addonPrice',20),'support',jsonb_build_object('level','standard'))),
      jsonb_build_object('code','professional','name','الاحتراف','price',345,'active',true,'smsCost',170,'serviceNet',175,'includedMessages',2000,'includedSubscribers',500,'subscribersLimitMode','maximum','fieldUsers',3,'platformUsers',3,'branches',1,'legacyPlan','professional','logoPolicy','addon','logoAddonPrice',20,'supportLevel','priority'),
      jsonb_build_object('code','business','name','الأعمال','price',456,'active',true,'smsCost',255,'serviceNet',201,'includedMessages',3000,'includedSubscribers',750,'subscribersLimitMode','maximum','fieldUsers',4,'platformUsers',3,'branches',1,'legacyPlan','enterprise','logoPolicy','included','logoAddonPrice',0,'subscriberLimitMode','maximum','supportLevel','priority_plus','features',jsonb_build_object('subscribers',jsonb_build_object('limit',750,'mode','maximum'),'sms',jsonb_build_object('limit',3000),'fieldUsers',jsonb_build_object('limit',4),'platformUsers',jsonb_build_object('limit',3),'branches',jsonb_build_object('limit',1),'logo',jsonb_build_object('enabled',true,'included',true,'addonPrice',0),'support',jsonb_build_object('level','priority_plus'))),
      jsonb_build_object('code','vip','name','الذهبية / VIP','price',567,'active',true,'smsCost',340,'serviceNet',227,'includedMessages',4000,'includedSubscribers',900,'subscribersLimitMode','minimum','fieldUsers',4,'platformUsers',4,'branches',2,'legacyPlan','enterprise','logoPolicy','included','logoAddonPrice',0,'supportLevel','highest_plus','subscriberLimitMode','minimum','features',jsonb_build_object('subscribers',jsonb_build_object('limit',900,'mode','minimum'),'sms',jsonb_build_object('limit',4000),'fieldUsers',jsonb_build_object('limit',4),'platformUsers',jsonb_build_object('limit',4),'branches',jsonb_build_object('limit',2),'logo',jsonb_build_object('enabled',true,'included',true,'addonPrice',0),'support',jsonb_build_object('level','highest_plus')))
    ),
    'addons', jsonb_build_object(
      'branch', jsonb_build_object('name','فرع إضافي','unit','branch','price',20),
      'fieldUser', jsonb_build_object('name','مستخدم ميداني إضافي','unit','user','price',10),
      'platformUser', jsonb_build_object('name','مستخدم منصة إضافي','unit','user','price',10)
    ),
    'smsAddons', jsonb_build_array()
  ) || coalesce((select value - 'packages' - 'version' - 'currency' - 'addons' - 'smsAddons' from public.platform_settings where setting_key='subscription_package_catalog'), '{}'::jsonb),
  'الكتالوج التجاري الموحد للباقات الخمس في PowerHub.'
)
on conflict(setting_key) do update
set is_enabled=excluded.is_enabled,
    value=excluded.value,
    message=excluded.message,
    updated_at=now();

insert into public.platform_settings(setting_key,is_enabled,value,message)
values (
  'branch_feature',
  true,
  jsonb_build_object(
    'packageLimits', jsonb_build_object('basic',1,'advanced',1,'professional',1,'business',1,'vip',2),
    'legacyFallback', jsonb_build_object('starter',1,'professional',1,'enterprise',1)
  ),
  'سياسة الأفرع حسب الباقات الخمس؛ VIP فرعان، وباقي الباقات فرع واحد.'
)
on conflict(setting_key) do update
set is_enabled=excluded.is_enabled,
    value=excluded.value,
    message=excluded.message,
    updated_at=now();

do $$
begin
  if exists (
    select 1 from public.platform_settings
    where setting_key='subscription_package_catalog'
      and jsonb_array_length(value->'packages') <> 5
  ) then
    raise exception 'PACKAGE_CATALOG_CONTRACT_INVALID';
  end if;
end $$;
