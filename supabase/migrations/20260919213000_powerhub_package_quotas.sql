insert into public.platform_settings(setting_key,is_enabled,value,message)
values
('owner_subaccount_limits',true,'{"limits":{"basic":2,"advanced":2,"professional":3,"business":3,"vip":4}}'::jsonb,'حدود الحسابات الفرعية حسب الباقات الخمس.'),
('owner_subscriber_limits',true,'{"limits":{"basic":150,"advanced":300,"professional":500,"business":750,"vip":900}}'::jsonb,'حدود المشتركين حسب الباقات الخمس؛ VIP يبدأ من 900.')
on conflict(setting_key) do update
set is_enabled=excluded.is_enabled,value=excluded.value,message=excluded.message;
