# P7.1 — Offline & Sync Foundation

## الهدف

إضافة قدرة العمل دون اتصال إلى **منصة PowerHub Web** نفسها، مع إبقاء Supabase/PostgreSQL مصدر الحقيقة النهائي، وعدم تحويل أي عملية مالية حساسة إلى عملية authoritative محلياً.

## ما تم بناؤه

- Service Worker بإستراتيجية network-first للتنقل وcache fallback لإعادة فتح المنصة عند انقطاع الإنترنت.
- Cache للأصول الثابتة على نفس الأصل حتى يمكن تحميل الواجهة بعد الانقطاع.
- Web App Manifest لتجهيز PowerHub كنظام PWA.
- تبقى Query cache منفصلة بسياسة TTL/حجم/مستخدم؛ أما مساحة العمل التشغيلية المشتركة `powerhub-offline-workspace` فتضم طابور العمليات، نطاقات الأرقام، طابور القراءات الميدانية، مؤشرات/كيانات Delta، حالة المزامنة، بيانات retry وملفات التعارض. المصادقة واللقطات المؤقتة الحساسة تبقى في مخازن منفصلة لسبب دورة الحياة والحساسية.
- تخزين Query results الناجحة لبيانات PowerHub التشغيلية فقط.
- Namespacing للتخزين حسب Supabase user id لمنع خلط cache بين حسابات مختلفة على الجهاز نفسه.
- استعادة snapshot محلي للمستخدم لتستمر واجهة workspace في التعرف على الجلسة أثناء الانقطاع؛ هذا snapshot للواجهة فقط وليس بديلاً عن تحقق الخادم.
- `networkMode: "offlineFirst"` لطلبات TanStack Query، مع إعادة الجلب عند عودة الاتصال.
- مؤشر عام يوضح أن PowerHub يعمل دون اتصال ويدل على مركز المزامنة.

## البيانات المسموح بتخزينها Offline في P7.1

الـcache يقتصر على العمليات التشغيلية غير المالية النهائية التي تدخل صراحة ضمن سياسة الكاش:

- الفروع والمحطات (`sites`).
- المشتركين (`subscribers`).
- القراءات وبيانات التشغيل المرتبطة بها (`readings`).
- التعرفات (`tariffs`).
- الجداول التشغيلية (`schedules`).
- أي Query تشغيلية أخرى فقط بعد إضافتها صراحة إلى allowlist الخاصة بالكاش.

لا يتم اعتبار ملخصات `dashboard` مصدراً محلياً موثوقاً، لأنها قد تتضمن مؤشرات مالية أو بيانات مجمعة لا ينبغي الاحتفاظ بها Offline ضمن P7.1.

## البيانات غير المسموح بتخزينها كمرجع نهائي Offline

لا يعتمد العميل على cache محلي باعتباره المصدر النهائي لـ:

- الدفعات.
- التحصيلات والأرصدة النهائية.
- التسويات المالية.
- صلاحيات الإدارة والمنصة.
- بيانات التدقيق الحساسة.
- إعدادات الرسائل أو عمليات الإدارة.
- أي Query مالية أو إدارية غير موجودة في allowlist التشغيلية.

الطوابير الموجودة للفواتير/التحصيلات تبقى **مسودات انتظار**؛ قبول الخادم فقط هو الذي يجعل العملية رسمية، مع استمرار idempotency وRLS والتحقق من النطاق.

## دورة العمل

```text
Online
  ↓
Fetch from Supabase
  ↓
Update TanStack Query
  ↓
Persist safe operational result to IndexedDB

Offline
  ↓
Read hydrated Query cache
  ↓
User works with last-known operational data
  ↓
Mutations require an explicit offline queue/draft implementation

Back Online
  ↓
TanStack Query refetches
  ↓
Pending drafts can be synchronized through the existing Offline Sync Center
```

## حدود P7.1

هذه المرحلة **ليست بعد** محرك مزامنة شامل لكل جداول PowerHub. لا يتم تنفيذ merge تلقائي لتعارضات السجلات، ولا يتم تحويل كل CRUD في المنصة إلى Offline mutation.

**حالة P7.2 في PR #332:** نُفّذ محرك Delta التدريجي، وOutbox الحالي يحافظ على معرف العملية وidempotency والاعتماديات وretry/backoff والحالات النهائية. أصبحت مخازن العمل المحلي والقراءات ونطاقات الأرقام وDelta/retry metadata متاحة عبر مخطط IndexedDB المشترك الإصدار 4. تحفظ حالات المزامنة والتعارضات بصورة دائمة، مع إبقاء البيانات المالية مرجعية خادمية فقط.

المتبقي لاعتماد الدفعتين تشغيليًا هو استكمال بوابة متصفح E2E على staging، وقياس التنقل وحجم Delta مقابل التحميل الكامل، ومراجعة ترقية المخطط وخطة الرجوع قبل أي ترحيل حقيقي. لا تعتبر نجاحات CI بديلًا عن تلك الخطوات.

## معايير القبول لـ P7.1

- TypeScript check يمر.
- Full test suite يمر.
- اختبار سياسة الـcache يمر.
- Production build يمر.
- Service Worker موجود في build.
- لا توجد تغييرات على Production أثناء تطوير P7.1.


## حالة التنفيذ الفعلية — 2026-10-24

- نجحت TypeScript وVitest وبناء الإنتاج وPostgreSQL Integration وPowerHub Security وSupabase Admin Guard على رأس الشفرة `1568612daaacac08f9b1b6fe326d7af6e14adfc8`.
- مخطط مساحة العمل التشغيلي هو الإصدار 4 ويشمل `operations`, `grants`, `claims`, `fieldReadings`, `orphanedFieldReadings`, `cursors`, `entities`, `syncState`, `conflicts`, و`syncMetadata`.
- ترحيل الطوابير القديمة محافظ؛ القراءات التي لا تملك user/site/subscriber scope تُحجر ولا تُحذف بصمت. لا تُحذف قاعدة المصدر إلا بعد اكتمال النسخ.
- ما زال PR #332 مفتوحًا ولم تُطبق ترحيلات على staging أو production. تبقى اختبارات متصفح E2E وrehearsal للمخطط وموافقة منفصلة قبل الدمج/التشغيل الفعلي.
