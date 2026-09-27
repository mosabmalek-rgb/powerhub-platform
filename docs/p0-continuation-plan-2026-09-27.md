# خطة استكمال P0 — PowerHub

**تاريخ الإعداد:** 2026-09-26  
**نقطة الاستئناف المقترحة:** 2026-09-27  
**النطاق:** تأهيل المنصة للتوسع، مع استثناء تفعيل Leaked Password Protection الذي سيفعله المستخدم يدويًا.

## 1. الحالة عند التوقف

تم إنجاز الدفعة الأولى من إصلاحات P0 على الفرع:

- **الفرع:** `fix/p0-production-readiness-20260926`
- **آخر commit:** `45c6504` — `chore: close initial P0 readiness gaps`
- **حالة الفرع:** متقدم عن `github/main` بcommit واحد، ولم يتم دفعه أو نشره تلقائيًا.
- **TypeScript:** `tsc --noEmit` ناجح.
- **اختبارات PowerHub:** ناجحة بعد معالجة عقود الاختبار والـmocks.
- **تغييرات Storage:** أُزيل Storage proxy العام غير الآمن وتسجيل مساره.
- **أرقام الفواتير:** أضيفت migration جديدة لمخصص `bigint`:
  `supabase/migrations/20260926190000_powerhub_bigint_invoice_allocator.sql`
- **اختبارات الهاتف والواجهة:** ناجحة بعد توحيد عقد رقم الهاتف وصلاحيات القائمة.

لم يتم حتى الآن:

- تطبيق migration على Production.
- دفع الفرع إلى GitHub أو فتح PR.
- نشر Production.
- تنفيذ اختبار ضغط حقيقي.
- إكمال keyset pagination.
- إكمال worker الموازي لطابور SMS.
- إكمال مراجعة وتطبيق RLS للجداول المتبقية.

## 2. الهدف التشغيلي

تأهيل PowerHub تدريجيًا لتحمل:

- 500+ صاحب مولد.
- 2,500+ مستخدم.
- 1,000,000 فاتورة أسبوعيًا.
- عزل صارم بين المستأجرين.
- استقرار عالٍ في الفواتير والتحصيل والرواتب.
- توافق كامل مع واجهة RTL.

## 3. ترتيب العمل المقترح للغد

### المرحلة A — تثبيت الدفعة الحالية ومراجعتها

1. مراجعة `git diff` وملف migration الخاص بمخصص الفواتير.
2. مقارنة migration الجديدة مع تاريخ migrations كاملًا لمنع التكرار أو التعارض.
3. تشغيل:
   - `tsc --noEmit`
   - Vitest الكامل
   - `git diff --check`
   - build الإنتاج المحلي إن أمكن.
4. مراجعة أمنية مركزة لتغيير Storage:
   - التأكد من عدم وجود مراجع تشغيلية ما زالت تعتمد على proxy العام.
   - التأكد أن روابط الملفات تمر عبر مسار مصادق ومحدود النطاق.
5. عدم تطبيق أي SQL على Production قبل اكتمال المراجعة وفتح PR.

### المرحلة B — إكمال أرقام الفواتير بطريقة قابلة للتوسع

1. فحص migration الحالية والدوال الفعلية المرتبطة بإصدار الفاتورة.
2. إثبات أن المسار الجديد:
   - لا يستخدم `COUNT(*)` لتوليد الرقم.
   - لا يحتوي سقف `9,999`.
   - يستخدم sequence أو allocator ذريًا من نوع `bigint`.
   - يحافظ على uniqueness والتزامن.
   - يحافظ على tenant isolation.
3. إضافة اختبارات عقدية لحالات:
   - إصدار متزامن.
   - تجاوز السنة أو الفترة.
   - إعادة المحاولة idempotently.
   - فشل الإدراج بعد حجز الرقم.
4. اختبار migration على staging أولًا، ثم توثيق نتيجة التحقق.

### المرحلة C — Keyset Pagination

تطبيق pagination من الخادم، بالترتيب التالي:

1. `meter_readings`.
2. `invoices`.
3. `payments`.
4. `expenses` والتقارير الثقيلة عند الحاجة.

العقد المقترح:

```ts
{
  limit: number,
  cursor?: { createdAt: string; id: number }
}
```

قواعد التنفيذ:

- ترتيب ثابت: `created_at DESC, id DESC`.
- شرط cursor مركب يمنع التكرار أو فقدان الصفوف.
- حد أقصى للخادم، مثل 100 أو 200 صف.
- عدم تحميل التاريخ الكامل في الواجهة.
- الحفاظ على tenant/site authorization قبل الاستعلام.
- تحديث الواجهات لإظهار تحميل الصفحة التالية وحالة النهاية.
- إضافة اختبارات للصفحة الأولى، cursor غير صالح، الترتيب، والعزل.

### المرحلة D — SMS Worker باستخدام SKIP LOCKED

1. مراجعة عقد `notification_messages` وحقول lease الحالية.
2. تصميم claim ذري باستخدام:
   - `FOR UPDATE SKIP LOCKED`.
   - `claimed_at` أو lease expiry.
   - batch size قابل للضبط.
   - tenant-safe filtering.
3. فصل المراحل:
   - claim.
   - إرسال خارج المعاملة.
   - finish success/failure/needs_review.
4. ضمان idempotency ومنع:
   - duplicate sends.
   - إعادة إرسال `needs_review` تلقائيًا.
   - تحرير claim قبل انتهاء lease.
5. اختبارات منافسين متوازيين، retry، timeout، وbatch boundaries.
6. اختبار throughput على staging دون إرسال SMS حقيقية.

### المرحلة E — RLS Hardening

1. إعادة جرد الجداول الـ17 التي لا تملك سياسات محددة كافية.
2. تصنيف كل جدول:
   - platform-only.
   - tenant-scoped.
   - site-scoped.
   - service-role-only.
   - public read محدود.
3. كتابة policies أقل صلاحية ممكنة.
4. منع الاعتماد على `service_role` في مسارات المستخدمين العاديين إلا عند الضرورة.
5. اختبار مصفوفة:
   - owner.
   - manager/accountant/collector/technician/viewer.
   - tenant A مقابل tenant B.
   - site A مقابل site B.
   - anon/authenticated/service_role.
6. عدم اعتبار RLS مكتملًا من خلال وجود policy فقط؛ يجب إثبات السلوك باستعلامات فعلية على staging.

## 4. بوابات الجودة قبل الدمج

لا يتم الدمج أو النشر قبل تحقق جميع البنود التالية:

- [ ] `tsc --noEmit` ناجح.
- [ ] Vitest الكامل ناجح، باستثناء اختبارات متخطاة موثقة.
- [ ] build ناجح.
- [ ] `git diff --check` ناجح.
- [ ] لا توجد أسرار أو مفاتيح في diff.
- [ ] migration history لا تحتوي duplicate أو drift غير موثق.
- [ ] اختبار عزل tenant ناجح.
- [ ] مراجعة code/security P0 ناجحة.
- [ ] Supabase migration مطبقة على staging ونتيجتها موثقة.
- [ ] PR gates: CI وSecurity وSupabase Admin Guard ناجحة.
- [ ] Production verification بعد النشر ناجح.

## 5. سياسة النشر

- العمل يستمر على فرع P0 ولا تُنشر التحديثات تدريجيًا أثناء التطوير.
- كل مجموعة مترابطة تُجمع في PR واضحة.
- لا يتم تطبيق migration مباشرة على Production قبل المرور عبر staging والمراجعة.
- لا يتم إرسال SMS حقيقية أو تنفيذ عمليات مالية أثناء الاختبارات.
- Leaked Password Protection خارج نطاق التنفيذ الآلي؛ سيقوم المستخدم بتفعيله يدويًا.

## 6. أول إجراء عند استئناف العمل

ابدأ بالخطوات التالية دون إعادة اكتشاف السياق:

```bash
cd /home/ubuntu/powerhub-p0
git status --short --branch
git log -1 --oneline
./node_modules/.bin/tsc --noEmit
node scripts/run-tests.mjs --run
git diff --check
```

بعد ذلك تُراجع migration `20260926190000_powerhub_bigint_invoice_allocator.sql` وتُقارن بتاريخ migrations، ثم ننتقل إلى keyset pagination قبل SMS worker وRLS.

## 7. ملاحظات التسليم

تم أيضًا بناء APK Debug للتطبيق الميداني من commit `161a930`، لكنه منفصل عن خطة P0 الخاصة بالمنصة. لا يُخلط مسار إصدار APK مع مسار دمج ونشر إصلاحات P0.
