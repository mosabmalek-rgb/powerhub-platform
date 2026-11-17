# PowerHub — سياق استئناف شامل بعد اعتماد خيار إعادة التأسيس داخل المشروع الحالي
**تاريخ التوثيق:** 2026-11-17  
**مرجع الخطة:** `docs/security/pr359-in-place-rebaseline-plan-20261117.md`  
**الحالة:** وثائق فقط، لا عمليات تغيير في Production أو Staging

## أ. موجز القرار

تم اختيار **الخيار الأول**: إعادة تأسيس قاعدة بيانات تطبيق PowerHub داخل **نفس** مشروعي Supabase الحاليين، لا إنشاء مشروعين جديدين، مع الاحتفاظ بمراجع المشاريع وروابطها. كل البيانات في البيئتين تجريبية، والمنصة لم تُطلق. التنفيذ الفعلي **لم يُؤذن به بعد**؛ لا إسقاط جداول أو تعديل سجل الترحيلات أو حذف مشاريع. يسبق Production ترتيب: R0 Inventory → R1 Backup+Restore proof → R2 Canonical Baseline/Epoch v2 → R3 Clean Local Supabase/Docker → R4 Staging in-place → R5 Acceptance → R6 Production in-place → R7 Closeout.

**ملحوظة حاسمة:** تاريخ 700 ترحيل و486/553 سجل قديم لا ينتهي تلقائيًا بمجرد تنظيف جداول التطبيق. حلّ `Migration Epoch v2` وسجل Supabase شرط قبل اعتبار إعادة التأسيس داخل المشروع أسرع/أأمن من إنشاء مشروع جديد. **لا تستخدم `supabase db reset --linked` أو `DROP SCHEMA public CASCADE` أو حذف `supabase_migrations` على البيئات الحية.**

## ب. هوية المستودعات والبيئات

| الأصل | القيمة |
| --- | --- |
| Web/Server | `mosabmalek-rgb/powerhub-platform` |
| Android field app | `mosabmalek-rgb/app-power-` |
| PR الرئيسي | #359، `Draft`، مفتوح وغير مدمج عند آخر تحقق |
| PR branch | `feat/auth-local-first-single-pr` |
| المرجع السابق لإضافة الوثائق | `f351e6eb027df363a1b46717032120fc67b05aac` |
| main عند التحقق السابق | `8602b155c410749ef04b79cb072cc59d5fed76bf` |
| Production Supabase Free | `vvcdiqcyhaloxesvpppc` |
| Staging Supabase Free | `iyuryuhaylhisjfcrwkz` |
| Docker shadow workflow | `.github/workflows/pr359-docker-shadow.yml` |
| GitHub protected environment | `pr359-shadow` |
| Secret name | `PR359_SHADOW_SOURCE_DB_URL`، لا تعرض قيمته |
| Enable variable | `PR359_ENABLE_PRODUCTION_DOCKER_SHADOW=true` |

## ج. بنية PowerHub والعقود

خادم React/Vite وTypeScript مع Express/tRPC، PostgreSQL/Supabase Auth وRLS، React Query، IndexedDB/Dexie باتجاه Offline-first؛ تطبيق القراءة الميدانية Native Kotlin/Compose/Room/WorkManager. التعدد Tenant/Generator/Branch مع أدوار إدارة وصاحب مولد ومحاسب وفني.

المجالات: الاشتراكات/التعريفات؛ مشتركين وقراءات دورية؛ فواتير وتحصيل وتوثيق تحويل؛ GL مزدوج مع مستندات المصدر؛ النقد والبنوك؛ مرتجعات الموردين، المخازن والوقود والصيانة؛ التقارير وB5 الأداء؛ Unified Messaging/رسائل وتنبيهات وقوالب؛ Feature entitlements/Quotas؛ support chat + PowerHub AI؛ Dashboard Delta + Mobile Delta + Offline outbox + جهاز واحد لكل مستخدم.

عقود خاصة ثبتت سابقًا:
- دورات القراءة WEEKLY/EVERY_10_DAYS/EVERY_15_DAYS/MONTHLY، وتواريخ فبراير الصحيحة، ومنازل 0/1/2 عشرية كما أدخل الفني.
- اختيار الفرع أو جميع الفروع، عرض قائمة صلاحيات افتراضية قابلة للمنح/السحب، وإخفاء أي تبويب/زر لا يملك المستخدم صلاحياته مع حراسة RPC والخادم، وتطبيق السحب أثناء الجلسة.
- إغلاق مالي متوازن وتزامن تحصيل Idempotency/RPC؛ لا تضيع عمليات Outbox عند إعادة الاتصال، وساعة جهاز منحرفة سبب سبق تشخيصه لحلقات الدخول.
- فتح فاتورة/روابط آمنة، اعتماد دفعة وإيصال، SMS من محفظة المولد فقط، دون إرسال رسائل حقيقية في الاختبارات.
- حد B5 للعقود ذات الصلة `p95=3000ms` (لا يتم رفع السقف لإخفاء الفشل).

## د. ما أُنجز سابقًا ومرحلة PR359

وفق سياق التطوير، أُنجزت مراحل المحاسبة A ثم B ثم C، مع اختبارات D متعددة؛ ثبت D36 tenant isolation في الاتجاهين وB5 p95 المقبول في جولات سابقة، ونجح سيناريو إنشاء المحاسب E46 عبر HTTPS، واختبارات تخصيص الصلاحيات E47/E50 وDelta mobile قيد التكامل/المراجعة. **هذه إنجازات على شفرات/SHAs سابقة وليست قبولًا تلقائيًا للـBaseline الجديد.** يجب إعادة مصفوفة قبول هذه المجالات بعد إعادة التأسيس.

على PR #359: تم العمل على historical migration reconciliation وledger evidence وP0 catalog، guards وأمان RLS وإصلاحات الدوال والماليات، واختبارات مالية Docker Synthetic. مهم: PR لا يُدمج حتى تكون بوابات CI المتفق عليها خضراء على نفس SHA، مع عدم نشر Production أو تعديل بياناته دون موافقة.

## هـ. لماذا تغيّر المسار؟

`supabase/migrations` يحتوي 700 SQL عند الجرد الأخير؛ سِجل Production لديه 486 نسخة تاريخية وسِجل Staging 553. 85 صفًا دون SQL محفوظ (82 Staging + 3 Production)، ومجموعة 28 اختلافًا تاريخيًا؛ الترحيلات المتشابهة بالأسماء ليست دليل تطبيق متكافئ. لدى Staging أعمال وميزات حديثة موجودة في SQL وغير مثبتة في Production، منها جدول `subscriber_balance_ledger` وأعمدة `payment_purpose` و`invoice_applied_amount` و`subscriber_credit_amount` وسلسلة ترحيلات التمويل:

1. `20261103131052_powerhub_subscriber_credit_ledger.sql`
2. `20261103131104_powerhub_subscriber_liability_and_cash_allocation.sql`
3. `20261103131125_powerhub_statement_operating_collection_summary.sql`
4. `20261103145232_powerhub_legacy_unlinked_payments_to_subscriber_credit.sql`

وعُرفت اختلافات في `powerhub_dashboard_financial_overview`، وسياسات chat/Realtime/storage وACLs. لذا إعادة تشغيل كل الملفات القديمة أو ترقية Production عمياء ليس مسارًا مضمونًا.

## و. أدلة حية تم التحقق منها (2026-11-17؛ قراءة فقط)

| المؤشر | Production | Staging |
| --- | ---: | ---: |
| جداول `public` | 145 | 173 |
| جداول `private` | 7 | 10 |
| دوال `public` | 389 | 579 |
| دوال `private` | 46 | 57 |
| دوال `powerhub_private` | 5 | 5 |
| Auth users | 4 | 7 |
| Storage objects | 5 | 0 |
| سجل الترحيلات | 486 | 553 |

قيود FK الموجهة إلى `auth.users`: `powerhub_user_device_locks_user_id_fkey`، `staff_password_reset_intents_auth_user_id_fkey`، `users_auth_user_id_fkey`. لا يجوز مسح أو نقل `public` دون اختبار عضويات/مصادقة الحسابات.

نتائج سابقة للمطابقة النقدية: Production 5 دفعات مكتملة بقيمة 1,260.00، و20 فاتورة إجمالي 4,647.30 والمدفوع 1,260.00 والمستحق 3,387.30، دون اختلافات الروابط النقدية في نطاق الاختبارات. Staging 6 دفعات بقيمة 667.00 و4 فواتير إجمالي 2,672.50 والمدفوع 667.00 والمستحق 2,005.50. هذه قيم اختبارية وليست مطلوبات للحفاظ عليها بعد Reset معتمد.

## ز. آخر بوابات GitHub CI المثبتة قبل مسار الخطة

على `f351e6eb027df363a1b46717032120fc67b05aac`:
- `PowerHub CI`: PASS
- `Reading Cycle PostgreSQL Integration`: PASS
- `Supabase Admin Guard`: PASS
- `B5 Synthetic Financial Load`: PASS
- `PowerHub Security`: FAIL بسبب `picomatch@4.0.7` / `GHSA-fc5q-39xc-vjpf` في الاعتماد غير المباشر `vite → picomatch`، دون إصدار مُصلح مثبت بذلك التاريخ؛ لا تتجاوز فحص audit.
- `PR359 Docker Shadow`: synthetic smoke PASS، `real-restored-finance` FAIL رغم تجاوزها مشكلة readiness السابقة. انتقل الاختبار إلى `verify-managed-catalog` ووجد `auth.custom_oauth_providers`/أعمدة `auth.flow_state` مفقودة واختلاف نوع `auth.audit_log_entries.ip_address`، بسبب عدم مطابقة managed Auth في صورة Docker لحالة المنصة المُدارة. **لا يثبت نجاح استعادة إنتاجية كاملة**؛ لا تخرّب مخططات Auth لتجعل اختبار الاستعادة يمر. المصدر ظل read-only.

مستندات الأدلة:
- `docs/security/pr359-phase1-migration-reconciliation-20261117.md`
- `docs/security/pr359-phase1-production-shadow-upgrade-runbook-20261117.md`
- `docs/security/pr359-free-docker-shadow-runbook-20261117.md`
- `docs/security/pr359-phase1-p0-live-catalog-review-20261117.md`
- `docs/security/pr359-migration-history-crosswalk-20261108.json`
- `scripts/pr359-finance-live-cash-proof.mjs`

## ح. الخطة الجديدة لا تعني تفويضًا بالحذف

راجع `docs/security/pr359-in-place-rebaseline-plan-20261117.md` كمرجع تفصيلي وحاكم. أول مهمة: تنفيذ **R0 جرد تصنيفي read-only** للأصل `APP_OWNED/MANAGED/UNKNOWN` واشتقاق Candidate Baseline وEpoch v2، ثم خطة Backup/Recovery مع اختبار فعلي، ثم Docker محلي نظيف وStaging أولًا. تبقى Production وStaging دون DDL، ولا تحذف صفوف `supabase_migrations` أو `auth.users` أو `storage.objects` يدويًا.

**قواعد قبول:** R1 restore PASS + R2 baseline PASS + R3 clean bootstrap PASS قبل أول تغيير في Staging. R4 staging + R5 المالية والأمن وAndroid/Offline/HTTP + جميع CI green قبل تصديق Production. خطوة Production R6 تتطلب موافقة صريحة مستقلة على أوامر محددة، وRunbook rollback مدققًا. `R0=NOT_ACCEPTED`, `R1..R7=NOT_STARTED`, `PR359_MERGE_GO=false` و`PRODUCTION_INPLACE_GO=false`.

## ط. الرسالة الافتتاحية المقترحة للمحادثة القادمة

`استأنف PowerHub PR #359 من خطة docs/security/pr359-in-place-rebaseline-plan-20261117.md وسياق docs/security/pr359-in-place-rebaseline-handoff-20261117.md. نفّذ R0 فقط أولًا: جرد APP_OWNED/MANAGED/UNKNOWN بمراجعة كتالوج Production وStaging read-only وتحليل اعتماديات Auth/Storage/Realtime وcron والـFK/Triggers/Function ACLs، وإنشاء candidate baseline وMigration Epoch v2 design. لا DROP أو DELETE أو supabase db reset --linked، لا نشر أو دمج، وابقِ PR Draft. وثّق الأدلة والقبول داخل PR على SHA واحد. وبعد R0 جهّز R1 Backup/Restore اختبار فعلي قبل أي DDL على Staging.`
