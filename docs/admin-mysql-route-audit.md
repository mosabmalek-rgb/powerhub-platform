# جرد مسارات MySQL في راوتر الإدارة العليا

**النطاق:** `server/admin.ts` في مسار الترحيل إلى Supabase. هذا الجرد توثيق داخلي فقط؛ لا يعني أن الترحيل الإنتاجي اكتمل.

## القراءات

تم نقل القراءات التشغيلية الرئيسية في `server/admin.ts` إلى Supabase، بما فيها الملخص المالي، المراقبة، لوحة التحليلات، البحث المركزي، تفاصيل المولد، TweetSMS، طلبات الترقية، الإشعارات، مركز الأمان، إعدادات الفروع ودليل الوصول.

## الكتابات

| المسار | الحالة |
|---|---|
| `setTenantMembershipStatus` | Supabase RPC + adapter + runtime wiring |
| `attachOwnerUser` | Supabase RPC + adapter + runtime wiring |
| `updateSubscription` | Supabase RPC + adapter + runtime wiring |
| `reviewSubscriptionUpgradeRequest` | Supabase RPC + adapter + runtime wiring |
| `renewSubscription` | RPC + adapter جاهزان؛ **runtime wiring HOLD** |
| `reviewSmsPackageRequest` | RPC + adapter جاهزان؛ **runtime wiring HOLD** |
| `quickUpgradeOwnerPlan` | Guarded Legacy |
| `invitePlatformAccess` / `setPlatformAccountStatus` / `setPlatformAccessRole` | Guarded Legacy |
| `inviteTenantAccess` | Guarded Legacy |
| `createGeneratorOwner` | Guarded Legacy؛ يوجد مسار أحدث يعتمد Supabase Auth + RPC |
| `createSmsPlan` / `updateSmsPlan` | Guarded Legacy |
| `updateComplaint` | Guarded Legacy |
| `createTariffPolicy` | Guarded Legacy؛ مسار P1 |
| `saveTenantBranchSettings` | Guarded Legacy |
| `savePlatformSetting` | Guarded Legacy؛ مسار P1 |
| `requestOwnerAccessRecovery` | Guarded Legacy؛ مسار أمني P1 |
| `saveRolePolicy` | Guarded Legacy؛ مسار صلاحيات P1 |

## قاعدة الترحيل

لا يُفعّل أي مسار Legacy قبل:
1. تحديد الـcallers الفعليين في Production.
2. تصميم RPC PostgreSQL ذرية عند وجود أكثر من جدول/أثر جانبي.
3. استخدام `SECURITY DEFINER` و`search_path = public, pg_temp` عند الحاجة.
4. حصر RPC الإداري على `service_role`.
5. إضافة contract/runtime tests.
6. إزالة guard للمسار المستهدف فقط.
7. تحقق CI/Preview قبل أي Production migration.

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
