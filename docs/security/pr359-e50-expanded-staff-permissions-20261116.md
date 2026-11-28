# E50 — إكمال محرر الصلاحيات الموسعة للحسابات الفرعية

**النطاق:** PR #359، 16 نوفمبر 2026. تم قبول الكود أولاً ثم ثُبّت ترحيل E50 على **Staging** وفق إفادة المالك؛ تحققنا مستقلًا من سجل النسخة ووظيفة RPC المثبتة، وأجرينا اختبارًا محدودًا داخل معاملة `ROLLBACK`. لا دمج ولا ترحيل Production ولا تجربة HTTPS طبقاً لتوجيه المالك.

## سبب التغيير

أنشأت E47 الصلاحيات الكاملة وقت إنشاء الحساب، لكن `FlexiblePermissionsPanel` و`staff.updatePermissions` وRPC القديمة لا تدعم إلا 14 صلاحية. كان الحفظ محظورًا للحساب ذي الحقوق الموسعة لحمايته من اقتطاع الحقوق في تعديل لاحق. E50 تقفل هذه الفجوة دون تغيير العقد القديم.

## التنفيذ

- `client/src/components/FlexiblePermissionsPanel.tsx`: تحرير صلاحيات الحساب الحالي من **الكتالوج الفعلي للمالك**؛ لا تُعرض ولا تُحفظ صلاحيات غير قابلة للتفويض. قبل الحفظ يجب اكتمال تحقق حديث `staff.permissionCatalog`، ووجود نسخة موثوقة `profile.updatedAt`. أي حق موجود سابقًا وخارج كتالوج المالك يحجب الحفظ ويظهر تنبيهًا، بدلاً من إسقاطه بصمت. الحسابات المرتبطة بدور مخصص لا تُهيأ بقائمة فارغة قبل وصول بيانات الدور؛ قائمة الصلاحيات الفردية منفصلة عن محرر الدور المخصص ذي النطاق القديم.
- `server/powerhub.ts`: مسار `staff.updateExpandedPermissions` مستقل عن المسار القديم؛ يتحقق من عضوية المالك والصلاحيات المتاحة ورفض التكرار والتصعيد، ويمرر نطاق الفرع ومعرّف الملف والحقوق والنسخة المتوقعة إلى RPC، ويحوّل التعارض إلى `CONFLICT` بلا محاولة كتابة بديلة.
- `supabase/migrations/20261116192000_powerhub_e50_expanded_staff_permission_updates.sql`: RPC مستقلة `powerhub_update_staff_profile_permissions_e50`، `SECURITY INVOKER` و`EXECUTE` لدور الخدمة فقط. حراسة المالك الفعّال والمستأجر والفرع وصلاحيات 41 ضمن E47، واستبعاد `manageTeam` و`manageMessaging` ومنع المنح المحظورة بسياسات المنصة/المالك؛ قفل السجل `FOR UPDATE` وفحص `updated_at` مع `STAFF_PERMISSION_VERSION_CONFLICT`. إعادة طلب مطابق للحالة المثبتة تُعيد `replayed=true` بلا تعديل أو تدقيق إضافي، أما التغيير الحقيقي فيحفظ قائمة صريحة بما فيها `[]` ويسجل `audit_logs.update_permissions` داخل المعاملة.
- مسار `staff.updatePermissions` القديم وRPC القديمة يبقيان كما هما للتوافق، ولا يُستخدمان للتعديل الموسع.

## الاختبارات المقصودة

- `supabase/tests/e50_staff_expanded_permission_updates.sql` على PostgreSQL 17 مستقل: حفظ حقوق موسعة، نسخة التعديل، تكرار آمن بلا سجل تدقيق إضافي، تعارض تعديل متقادم، قائمة فارغة، منع الحقوق المحجوزة أو المكررة أو غير النصية، سياسة DENY، مالك أجنبي، فرع أجنبي، دور مخصص أجنبي، وعملية مستخدم عام لكل الأفرع.
- خطوة إلزامية جديدة في `.github/workflows/reading-cycle-sql-integration.yml` لاختبار SQL الفعلي.
- اختبارات `server/powerhub.core-lists-supabase.test.ts` لمصفوفة API والاستجابة عند التعارض والتفويض.
- اختبارات `client/src/pages/role-guards.ui.test.tsx` لعرض الحقوق الموسعة، إرسال `expectedUpdatedAt`، ومنع الإلغاء الصامت للحقوق غير المتاحة.

## تثبيت E50 واختبار قبول Staging بعد الترحيل

- استعلام مستقل من Staging `iyuryuhaylhisjfcrwkz` أثبت وجود نسخة الترحيل `20261116192000` باسم `powerhub_e50_expanded_staff_permission_updates` في `supabase_migrations.schema_migrations`، مع بقاء E47 مثبتاً بالإصدار `20261116175000`.
- الدالة `public.powerhub_update_staff_profile_permissions_e50(bigint,bigint,bigint,bigint,bigint,jsonb,timestamptz)` موجودة، `SECURITY INVOKER`، و`search_path=pg_catalog, public, pg_temp`، و`EXECUTE` لدور `service_role` فقط، دون `anon` أو `authenticated`. تعريفها يحتوي حراسة `FOR UPDATE` و`STAFF_PERMISSION_VERSION_CONFLICT` و`STAFF_PERMISSION_OUTSIDE_OWNER_SCOPE`.
- تم تنفيذ اختبار سلوكي فعلي ضد **الدالة المثبّتة** في معاملة `BEGIN → SET LOCAL ROLE service_role → DO → ROLLBACK` على ملف حساب المحاسب الاختباري في Staging (tenant 1، فرع 9000000000099، profile 10) دون حفظ دائم. غطّى الحفظ الصريح لحق `approvePaymentDocumentation` وحده، زيادة نسخة `updated_at`، سجل التدقيق، تكرار طلب مطابق بلا تكرار تدقيق، رفض تعارض نسخة قديمة، سحب الحقوق إلى `[]`، رفض `manageTeam`، رفض الفرع الآخر، ورفض actor غير مالك. النتيجة `E50_INSTALLED_STAGING_TRANSACTION_ROLLBACK_ACCEPTANCE_PASS`.
- بعد `ROLLBACK`، أثبت استعلام مستقل أن `permissions IS NULL` كما كانت، وأن `updated_at` مساوية للبصمة الأصلية. لم يبقَ أثر دائم للاختبار على الملف.
- بوابات CI الخمس كانت **5/5 SUCCESS** على رأس الكود السابق `1697c1de32d037ae571993bb7f586a45631eaf84` قبل تحديث هذا التوثيق: PowerHub CI `43937756667`، PostgreSQL Integration `43937756674`، Security `43937756816`، Admin Guard `43937756875`، B5 `43937756564`. يجب مراجعة بوابات الرأس الجديد للتوثيق ولا تُنقل نتائج الرأس السابق آلياً.
- **الحدود:** لا توجد جلسة متصفح مصادقة أو فحص HTTPS E50، ولا اختبار تزامن حقيقي بجلستين مستقلتين على Staging. فحص رفض النسخة القديمة داخل معاملة واحدة لا يثبت سباق جلستين حقيقيتين؛ لا تُنسب إليه هذه النتيجة. نجاح SQL المثبت لا يعني قبول E2E أو جهوزية Production.

```text
E50_STAGING_MIGRATION=INSTALLED
E50_STAGING_FUNCTION_ACL=PASS
E50_INSTALLED_STAGING_ROLLBACK_FUNCTIONAL=SCOPED_PASS
E50_STAGING_TEST_DATA_RESTORED=PASS
E50_INDEPENDENT_SESSION_CONCURRENCY=NOT_TESTED_ON_STAGING
E50_AUTHENTICATED_HTTPS=DEFERRED_BY_OWNER
E50_PRODUCTION=UNTOUCHED
PR_359=OPEN_DRAFT_UNMERGED
```

