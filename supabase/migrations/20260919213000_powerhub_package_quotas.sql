-- PowerHub: package catalog is authoritative for quota defaults.
update public.platform_settings
set is_enabled=true,
    value='{"limits":{"basic":2,"advanced":2,"professional":3,"business":3,"vip":4}}'::jsonb,
    message='حدود الحسابات الفرعية حسب الباقات الخمس.'
where setting_key='owner_subaccount_limits';

update public.platform_settings
set is_enabled=true,
    value='{"limits":{"basic":150,"advanced":300,"professional":500,"business":750,"vip":900}}'::jsonb,
    message='حدود المشتركين حسب الباقات الخمس؛ VIP يبدأ من 900.'
where setting_key='owner_subscriber_limits';
