# جرد مسارات MySQL في راوتر الإدارة العليا

**النطاق:** `server/admin.ts` في مسار الترحيل إلى Supabase. هذا الجرد توثيق داخلي فقط؛ لا يعني أن الترحيل الإنتاجي اكتمل.

## الكتابات

- `setTenantMembershipStatus` — Supabase RPC + adapter + runtime wiring.
- `attachOwnerUser` — Supabase RPC + adapter + runtime wiring.
- `updateSubscription` — Supabase RPC + adapter + runtime wiring.
- `reviewSubscriptionUpgradeRequest` — Supabase RPC + adapter + runtime wiring.
- `quickUpgradeOwnerPlan` — Supabase RPC + adapter + runtime wiring.
- `renewSubscription` — Supabase RPC + adapter + runtime wiring.
- `reviewSmsPackageRequest` — Supabase RPC + adapter + runtime wiring.
- `invitePlatformAccess` — Supabase invitation RPC + adapter + runtime wiring + Auth acceptance flow.
- `setPlatformAccountStatus` — Supabase RPC + adapter + runtime wiring.
- `setPlatformAccessRole` — Supabase RPC + adapter + runtime wiring.
- بقية الكتابات الإدارية ما زالت Guarded Legacy إلى حين تصميم RPC ذرية واختبارات مناسبة.

## قاعدة الترحيل

لا يُفعّل أي مسار Legacy قبل تحديد الـcallers الفعليين، وتصميم RPC PostgreSQL ذرية عند وجود آثار جانبية متعددة، وتثبيت `SECURITY DEFINER` و`search_path = public, pg_temp` عند الحاجة، وحصر التنفيذ على `service_role`، ثم إضافة contract/runtime tests وإزالة الـguard للمسار المستهدف فقط.

## Exit Gate

```text
Production getDb() runtime callers = 0
Production Drizzle table queries = 0
Production Drizzle transactions = 0
Production MySQL runtime dependency = 0
DATABASE_URL runtime dependency = 0
shared/types -> drizzle/schema = 0
Supabase Runtime for Admin / Messaging / PowerHub
CI Guard against Production Drizzle runtime
Focused E2E + final architecture audit
```
