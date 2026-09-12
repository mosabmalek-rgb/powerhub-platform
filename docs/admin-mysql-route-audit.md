# جرد مسارات MySQL في راوتر الإدارة العليا

**النطاق:** `server/admin.ts` في مسار الترحيل إلى Supabase. هذا الجرد توثيق داخلي فقط؛ لا يعني أن الترحيل الإنتاجي اكتمل.

## الكتابات المرحّلة إلى Supabase

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
- `createTariffPolicy` — Supabase RPC + adapter + runtime wiring؛ السياسة والإشعارات والتدقيق تُكتب ضمن RPC ذرية واحدة.

## الكتابات المتبقية

- `inviteTenantAccess`
- `createGeneratorOwner` (Legacy؛ يوجد مسار أحدث لإنشاء صاحب المولد/الاشتراك عبر Supabase ويجب تقييم إزالة هذا المسار بدل إعادة بنائه.)
- `createSmsPlan`
- `updateSmsPlan`
- `updateComplaint`
- `saveTenantBranchSettings`
- `savePlatformSetting`
- `requestOwnerAccessRecovery`
- `saveRolePolicy`

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
