# P7.1 — Offline & Sync Foundation

## الهدف

إضافة قدرة العمل دون اتصال إلى **منصة PowerHub Web** نفسها، مع إبقاء Supabase/PostgreSQL مصدر الحقيقة النهائي، وعدم تحويل أي عملية مالية حساسة إلى عملية authoritative محلياً.

## ما تم بناؤه

- Service Worker بإستراتيجية network-first للتنقل وcache fallback لإعادة فتح المنصة عند انقطاع الإنترنت.
- Cache للأصول الثابتة على نفس الأصل حتى يمكن تحميل الواجهة بعد الانقطاع.
- Web App Manifest لتجهيز PowerHub كنظام PWA.
- IndexedDB cache منفصل عن طوابير المسودات الميدانية القائمة.
- تخزين Query results الناجحة لبيانات PowerHub التشغيلية فقط.
- Namespacing للتخزين حسب Supabase user id لمنع خلط cache بين حسابات مختلفة على الجهاز نفسه.
- استعادة snapshot محلي للمستخدم لتستمر واجهة workspace في التعرف على الجلسة أثناء الانقطاع؛ هذا snapshot للواجهة فقط وليس بديلاً عن تحقق الخادم.
- `networkMode: "offlineFirst"` لطلبات TanStack Query، مع إعادة المحاولة عند عودة الاتصال.
- مؤشر عام يوضح أن PowerHub يعمل دون اتصال ويدل على مركز المزامنة.

## البيانات المسموح بتخزينها Offline في P7.1

الـcache يقتصر على العمليات التشغيلية غير المالية النهائية:

- الفروع والمحطات.
- المشتركين.
- القراءات وبيانات التشغيل المرتبطة بها.
- التعرفات.
- بعض ملخصات لوحة التشغيل.
- الجداول التشغيلية عندما تكون ضمن Query قابلة للـcache.

## البيانات غير المسموح بتخزينها كمرجع نهائي Offline

لا يعتمد العميل على cache محلي باعتباره المصدر النهائي لـ:

- الدفعات.
- التحصيلات والأرصدة النهائية.
- التسويات المالية.
- صلاحيات الإدارة والمنصة.
- بيانات التدقيق الحساسة.
- إعدادات الرسائل أو عمليات الإدارة.

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

المرحلة التالية P7.2 يجب أن توحد طوابير العمليات الحالية في Sync Engine واحد وتضيف:

1. operation dependency ordering.
2. idempotency موحدة لكل العملية.
3. conflict records قابلة للمراجعة.
4. retry/backoff.
5. مزامنة تلقائية للعمليات التشغيلية المسموح بها.
6. اختبارات انقطاع الاتصال والعودة المتكررة.

## معايير القبول لـ P7.1

- TypeScript check يمر.
- Full test suite يمر.
- اختبار سياسة الـcache يمر.
- Production build يمر.
- Service Worker موجود في build.
- لا توجد تغييرات على Production أثناء تطوير P7.1.
