# PowerHub P7 Production Release — 2026-09-11

## نطاق الإصدار

تم إطلاق ميزات **P7.3 Broader Offline CRUD** ثم **P7.4 Generator Offline Sync Status** بالتسلسل إلى فرع `main` والإصدار الإنتاجي في Vercel. لم يُضمّن هذا الإصدار مسار QA الخاص بـAgent Browser، ولا PRs القديمة أو أعمال تنظيف الفروع والقضايا.

## سجل الدمج

| المرحلة | Pull Request | النتيجة | Commit الدمج |
|---|---:|---|---|
| P7.3 | [#21](https://github.com/mosabmalek-rgb/powerhub-platform/pull/21) | Merged إلى `main` | `fe0c977602c1459fb7c14b949c260241ecf1b83a` |
| P7.4 | [#31](https://github.com/mosabmalek-rgb/powerhub-platform/pull/31) | Merged إلى `main` بعد تحديث base إلى `main` | `eb98fab7caa379c478367cb7bd23b565166e4f1a` |

## ما أصبح متاحاً في Production

يشمل الإصدار طابور Offline CRUD الموسع للمولدات، التخزين المحلي عبر IndexedDB، replay idempotent باستخدام `clientOperationId`، optimistic concurrency، معالجة التعارضات، عزل المستأجر والمحطة، حماية RPCs القديمة، وإظهار حالة مزامنة المولد داخل دليل الشبكة بحالات pending وapplied وfailed وconflict وretry مع حالة الاتصال.

تظل العمليات المالية الحساسة server-authoritative، ولم يُستبدل مسار المشتركين أو الفواتير أو الدفعات بمسار غير متصل غير محكوم.

## تحقق Vercel

| النشر | Commit | الحالة | النطاق |
|---|---|---|---|
| P7.3 | `fe0c977602c1459fb7c14b949c260241ecf1b83a` | `READY` | `production` |
| P7.4 | `eb98fab7caa379c478367cb7bd23b565166e4f1a` | `READY` | `production` |

تم فتح رابط Production بعد الإصدار واستجاب بالواجهة العامة الصحيحة لمنصة PowerHub.

## خارج الإصدار عمداً

بقي PR #33 الخاص بـAgent Browser E2E مفتوحاً Draft، وبقي PR #17 وPR #1 والقضايا التاريخية وقضايا الاختبارات المكررة خارج الدمج. كما لم يبدأ P7.5 أو أي إعادة تصميم جديدة لمحرك المزامنة.

## ملاحظات تشغيلية

ينبغي قبل استخدام الوضع غير المتصل على نطاق ميداني واسع تنفيذ تجربة محدودة على جهاز فني واحد، ثم مراجعة أحداث pending وapplied وfailed وconflict في لوحة المزامنة. كما ينبغي إنشاء PR صيانة مستقل لاحقاً لتوسيع triggers الخاصة بـCI لفروع P7 وتنظيف PRs والقضايا المتجاوزة بعد اعتماد الإصدار.
