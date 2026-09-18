-- Flexible commercial package catalog. Runtime subscription identifiers remain
-- backward-compatible while Platform Admin controls prices and quotas from JSON.
insert into public.platform_settings (setting_key, is_enabled, value, message)
values (
  'subscription_package_catalog',
  true,
  '{
    "currency": "ILS",
    "version": 1,
    "packages": [
      {
        "code": "basic",
        "name": "الأساسية",
        "legacyPlan": "starter",
        "originalPrice": 119,
        "price": 143,
        "includedMessages": 600,
        "smsCost": 54,
        "grossProfit": 89,
        "platformUsers": 2,
        "fieldUsers": 1,
        "branches": 1,
        "includedSubscribers": 0,
        "active": true
      },
      {
        "code": "advanced",
        "name": "المتقدمة",
        "legacyPlan": "professional",
        "originalPrice": 209,
        "price": 251,
        "includedMessages": 1200,
        "smsCost": 108,
        "grossProfit": 143,
        "platformUsers": 3,
        "fieldUsers": 2,
        "branches": 1,
        "includedSubscribers": 0,
        "active": true
      },
      {
        "code": "business",
        "name": "الأعمال",
        "legacyPlan": "enterprise",
        "originalPrice": 269,
        "price": 323,
        "includedMessages": 1800,
        "smsCost": 162,
        "grossProfit": 161,
        "platformUsers": 3,
        "fieldUsers": 3,
        "branches": 1,
        "includedSubscribers": 0,
        "active": true
      },
      {
        "code": "institutional",
        "name": "المؤسسات",
        "legacyPlan": "enterprise",
        "originalPrice": 339,
        "price": 407,
        "includedMessages": 2500,
        "smsCost": 225,
        "grossProfit": 182,
        "platformUsers": 4,
        "fieldUsers": 3,
        "branches": 2,
        "includedSubscribers": 0,
        "active": true
      }
    ],
    "addons": {
      "fieldUser": { "name": "مستخدم ميداني إضافي", "price": 10, "unit": "user", "max": null },
      "platformUser": { "name": "مستخدم منصة إضافي", "price": 10, "unit": "user", "max": null },
      "branch": { "name": "فرع إضافي", "price": 20, "unit": "branch", "max": null },
      "subscribers50": { "name": "50 مشترك إضافي", "price": 20, "unit": "subscriber_bundle", "quantity": 50, "maxBundles": 2 }
    },
    "smsAddons": [
      { "messages": 500, "price": 55 },
      { "messages": 1000, "price": 100 },
      { "messages": 5000, "price": 450 },
      { "messages": 10000, "price": 850 }
    ]
  }'::jsonb,
  'الأسعار والحدود قابلة للتعديل من لوحة آدمن المنصة دون تعديل الكود.'
)
on conflict (setting_key) do update set
  is_enabled = excluded.is_enabled,
  value = excluded.value,
  message = excluded.message,
  updated_at = now();
