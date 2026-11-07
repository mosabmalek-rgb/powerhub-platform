# PowerHub — سجل المراجعة الأمنية والتنفيذية التراكمي

**آخر تحديث:** 7 نوفمبر 2026  
**مصدر التحقق:** GitHub + PostgreSQL Staging read-only + اختبارات PostgreSQL المعزولة في GitHub Actions.  
**الغرض:** سجل مرجعي يمنع إعادة فتح مراجعات أُغلقت سابقاً لمجرد الانتقال إلى محادثة جديدة. لا يعاد فتح بند مُثبت إلا عند تغيّر الكود أو Migration أو بيئة التشغيل، أو ظهور دليل جديد يناقض نتيجة سابقة.

> هذا السجل ليس إذناً بالدمج أو النشر أو تنفيذ Migration على بيئة حية. حالة كل بند مرتبطة بالـSHA والتشغيلات المحددة أدناه.

## 1. ثوابت التشغيل

- المستودع: `mosabmalek-rgb/powerhub-platform`.
- الفرع: `feat/auth-local-first-single-pr`.
- PR: [#359](https://github.com/mosabmalek-rgb/powerhub-platform/pull/359).
- PR يجب أن يظل OPEN + DRAFT + NOT MERGED حتى موافقة صريحة.
- ممنوع Force Push.
- بعد كل Commit يجب ربط النتائج النهائية بـSHA واحد.
- لا اختبارات أو معاملات مالية أو SMS حقيقية على Production.
- لا حذف بيانات أو ملفات حقيقية، ولا تغيير أقفال الأجهزة أو حسابات المستخدمين.
- لا Migration على Production.
- لا Migration على Staging قبل مطابقة اسم الملف ومحتواه وتاريخه مع السجل، واختبارها في PostgreSQL المعزول.
- لا Vercel Preview إضافي ولا Browser E2E قبل إثبات أن جميع متغيرات Preview السرية تخص Staging.
- لا تعتبر SKIPPED نجاحاً.

## 2. رأس الكود وحالة GitHub عند آخر تحقق

**آخر SHA موثق قبل هذا السجل:**

`2e3c5ad1336ea16ddf72ca62135343228d02f3fc`

الرسالة:
`fix(security): route supplier reads through capability-checked server APIs`

- رأس PR #359 ورأس الفرع طابقا SHA أعلاه.
- PR مفتوح ومسودة وغير مدمج.
- لم يُستخدم Force Push.
- لا توجد تغييرات على Production أو نشر Vercel ضمن مرحلة إصلاح صلاحيات الموردين.

### بوابات CI على SHA نفسه

| الفحص | Run ID | النتيجة |
|---|---:|---|
| Reading Cycle PostgreSQL Integration | 42366358473 | SUCCESS |
| PowerHub CI | 42366358519 | SUCCESS |
| PowerHub Security | 42366358475 | SUCCESS |
| Supabase Admin Guard | 42366358530 | SUCCESS |
| PowerHub SBOM | 42366358474 | SUCCESS |

روابط التشغيل:
- [PostgreSQL Integration](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42366358473)
- [PowerHub CI](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42366358519)
- [PowerHub Security](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42366358475)
- [Supabase Admin Guard](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42366358530)
- [SBOM](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42366358474)

PowerHub Security: Dependency review وCodeQL وDependency audit جميعها SUCCESS في هذا التشغيل.

## 3. الإصلاح الأخير: صلاحيات قراءة الموردين

### السبب

جداول المشتريات ودفعات الموردين وكشف المورد كانت تمنح `authenticated` صلاحية SELECT مباشرة. سياسات RLS السابقة فرضت حدود المستأجر والفرع، لكنها لم تفرض كل قدرات التطبيق الدقيقة. خادم tRPC كان يفرض قدرات مثل `viewSuppliers` و`viewPurchases` و`viewSupplierLedger` و`manageSupplierPayments` قبل إعادة البيانات. القراءة المباشرة عبر PostgREST كانت مساراً موازياً يتجاوز فحص القدرة الدقيق.

تم التحقق من أن مسارات قراءة بيانات الموردين المستخدمة في التطبيق موجودة في `server/powerhub-inventory-router.ts` وتنفذ عبر الخادم مع فحوص القدرات ونطاق الفرع. لا يوجد مسار عميل مباشر لهذه الجداول ضمن نتائج البحث التي تمت مراجعتها.

### الملفات المضافة/المعدلة

- Migration جديدة:
  `supabase/migrations/20261107150000_powerhub_supplier_browser_read_acl_revoke.sql`
- اختبار:
  `supabase/tests/inventory_supplier_site_rls_scope.sql`

الـMigration تستهدف:
1. `suppliers`
2. `supplier_purchases`
3. `supplier_purchase_lines`
4. `supplier_purchase_receipts`
5. `supplier_purchase_receipt_lines`
6. `supplier_payments`
7. `supplier_payment_allocations`
8. `supplier_ledger_entries`
9. `supplier_purchase_returns`
10. `supplier_purchase_return_lines`

قبل التغيير تتحقق من وجود الجداول وRLS وصلاحية قراءة `service_role`. بعد ذلك تسحب امتيازات الجدول والأعمدة من `PUBLIC` و`anon` و`authenticated`، وتتحقق من عدم بقاء منح قراءة/كتابة للمتصفح ومن استمرار قراءة `service_role`.

الاختبار يحافظ أولاً على تغطية عزل الفرع والمستأجر، ثم يشغّل Migration في قاعدة مؤقتة ويثبت عدم وجود منح قراءة أو كتابة للمتصفح، مع بقاء قراءة الخدمة الخادمية.

**نتيجة التحقق:** خطوة PostgreSQL Integration رقم #38:
`Verify supplier purchasing, receipts, returns, payments, and ledger are branch-scoped for direct reads`
نجحت، وظهر marker:
`INVENTORY_SUPPLIER_SITE_RLS_AND_SERVER_ONLY_READ_OK`

### حالة Migration الحية

لم يتم تطبيق `20261107150000` على Staging أو Production في آخر تحقق. نجاح #38 هو نجاح داخل PostgreSQL معزول، وليس إثبات تطبيقها على قاعدة حية.

## 4. سجل المجالات التي تمت مراجعتها واختبارها

التصنيف هنا يعني «اختبارات CI/fixture نجحت على SHA أعلاه»؛ لا يعني أن كل مجال اجتاز قبول متصفح حياً أو تم نشره للإنتاج.

| المجال | ما تمت مراجعته/تدعيمه | إثبات CI أو الاختبار | الحالة |
|---|---|---|---|
| الدردشة وعضوية المحادثة | هوية المستخدم، الحساب النشط، عضوية المستأجر، صلاحية المشارك، رسائل الدعم، الإيصالات والحدود | #44، #79، واختبارات Chat RPC | مُراجع ومختبر |
| إدارة مركز الدعم | `manageSupportChat`، رفض المستخدم العادي والحساب الموقوف، منع الكتابة المباشرة على الإعدادات | #80 و`chat_support_admin_capability_scope.sql` | مُراجع ومختبر |
| الإشعارات | ربط البيانات بـ`auth.uid()`، منع JWT المفقود وanon، منع آثار جانبية عند الرفض | #87 و`powerhub_notification_rpc_user_scope.sql` | مُراجع ومختبر |
| RPCs الدردشة الـ34 | ACL، `SECURITY DEFINER`، `search_path`، واجهة public مقابل التنفيذ الخاص، وعدم منح anon/PUBLIC | فحص Staging و#79 وما يتصل به من اختبارات | مُراجع؛ واجهات authenticated مقصودة |
| مزامنة المولد | عضوية المالك الصالحة وغير المنتهية، الحساب النشط، قدرة إدارة المولد، عزل الفرع وIdempotency | #59 | مُراجع ومختبر |
| رصيد المشترك والتأمين | فصل `available_credit` عن `security_deposit`، قيد application، ربط مصدر التأمين، تطبيق الرصيد مرة واحدة | #5 و#30 | مُراجع ومختبر |
| قفل الفترات والتسوية المالية | حارس مصدر الحركة، تاريخ الحركة، بصمة التسوية، منع تعديل المصدر بعد القفل، سباق الكتابة/القفل | #20 و#21 و#22 | مُراجع ومختبر |
| دفعات الشركة والتحويلات | idempotency، محاولات متزامنة، الحركات اليدوية، التسوية وعزل الفروع | #19 و#29 و#61 | مُراجع ومختبر |
| الحسابات المشتركة | ربط الحساب بالفروع، منع قراءة فرع غير مسموح، الأدوار والهوية المميزة | #17 و#61 و`financial_site_rls_scope.sql` | مُراجع ومختبر |
| HR والرواتب | صلاحية `managePayroll/manageExpenses` في حدود القراءة المباشرة، الموظف والفرع، عناصر الرواتب | #62 | مُراجع ومختبر |
| HR Delta والسلف والقروض | تقليل الحمولة، tombstones، حدود العضوية، عزل المستأجر/الفرع، الأقساط والسداد وIdempotency | #68 و#69 و#71 | مُراجع ومختبر |
| المخزون والمشتريات | التزامن، Idempotency، مطابقة دفتر المخزون، التكلفة، عزل المستأجر، وحدات القياس والاستلام | #36 و#37 و#65 | مُراجع ومختبر |
| الموردون | الشراء والاستلام والمرتجعات والدفعات والدفتر، عزل الفرع، إغلاق PostgREST المباشر، الإبقاء على مسار الخدمة | #38 | مُصلح ومختبر؛ Migration غير مطبقة حياً |
| Delta للمخزون | العضوية المحدودة، الحذف والنقل وتغير النطاق | #39 | مُراجع ومختبر |
| الوقود والصيانة | أحداث الوقود، القراءات، أوامر العمل، قطع الغيار، التكلفة، حدود الخادم، Idempotency | #37 و#67 | مُراجع ومختبر |
| Storage | الحاوية الخاصة، نطاق المستأجر، منع mutations من المتصفح، إرفاق المحادثة | #82 | مُراجع ومختبر |
| تنظيف مراجع الصور | ذرية التنظيف، retry وACL الخادمية | #81 | مُراجع ومختبر آلياً؛ يلزم التحقق من نتائج Cron الحية |
| روابط مشاركة الفواتير | هوية المستأجر والفرع، أهلية الدفع وحالة الفاتورة، ACL خادمية | #83 | مُراجع ومختبر |
| Realtime وDelta | صلاحية الموضوع، نطاق القناة، تقليل payload، invalidation للمستندات المالية | #48 و#49 | مُراجع ومختبر |
| الهوية وصلاحيات المنصة | حدود مساعدات RLS وهوية مسؤول المنصة والعضوية، نقل/تهيئة المسؤول المعتمد | #50–#54 | مُراجع ومختبر |
| الأدوار المخصصة | التوقيع، idempotency، fingerprint conflict وACL | #66 و#73 | مُراجع ومختبر |
| الدعوات | نطاق الدعوة وIdempotency والتزامن وACL الخادمي | #72 | مُراجع ومختبر |
| مؤشرات الإدارة والبحث | القراءة فقط، أرقام الخادم، نطاق المالك/المستأجر، خصوصية نص البحث | #75–#78 | مُراجع ومختبر |
| الرسائل والأتمتة | دورة الرسائل، إنشاء الفاتورة، التنسيق ومنع التكرار | #23 و#24 و#27 | مُراجع ومختبر |
| أمان جداول الخدمة/المفاتيح | سجلات التنبيه والحصص، trigger functions، العمليات الداخلية | #31 و#34 و#55–#57 و#84–#85 | مُراجع ومختبر |
| فهارس المسارات الساخنة | مطابقة فهارس المولدات والقراءات والمؤشرات المالية وupdated_at | #63 و#64 | مُراجع ومختبر آلياً؛ قياس حمل واقعي ما زال مطلوباً |

## 5. فحص قاعدة Staging المباشر — آخر قراءة فقط

المشروع:
- ID: `iyuryuhaylhisjfcrwkz`
- الاسم: `powerhub-staging-dr`
- المنطقة: `ap-southeast-1`
- PostgreSQL: `17.6.1.166`
- الحالة عند آخر استعلام: `ACTIVE_HEALTHY`
- عدد الترحيلات: 424
- أحدث ترحيل: `20261106224902_powerhub_payment_delta_purpose_projection`

### فحص جميع جداول public

- عدد جداول `public`: 155.
- جداول RLS غير المفعّل: 0.
- جداول بلا سياسات RLS وتمنح anon/authenticated وصولاً مباشراً: 0.
- الجداول الـ64 التي أظهرها Advisor على أنها RLS-enabled/no-policy لا تمنح anon/authenticated امتيازات جدول مباشرة في الفحص الحالي.

هذه نتيجة مهمة: تحذير `rls_enabled_no_policy` على الـ64 جدولاً لا يعني في الحالة الحالية أن المتصفح يستطيع الوصول إليها. كثير منها جداول خدمة داخلية ينبغي أن تبقى بلا سياسات وبلا منح للمتصفح.

### دوال SECURITY DEFINER

فُحصت الدوال القابلة للتنفيذ من anon أو authenticated في مخططي `public/private`:

- 47 دالة SECURITY DEFINER قابلة للمستخدم المصادق.
- anon/PUBLIC: صفر.
- جميع الدوال لها `search_path` مثبت.
- 34 منها واجهات public المقصودة للدردشة والإشعارات ومزامنة المولد.
- 13 مساعداً في private، منها مساعدات تعتمد عليها سياسات RLS وRealtime.
- أربع مساعدات RLS/Realtime لا تمنح service_role EXECUTE؛ هذا مقصود لأن service_role يتجاوز RLS ولا يحتاج استدعاء هذه المساعدات مباشرة:
  - `private.chat_rls_can_select_conversation`
  - `private.chat_rls_can_select_participant`
  - `private.powerhub_has_platform_capability`
  - `private.powerhub_realtime_can_read_delta_topic`

لا تسحب authenticated من هذه المساعدات أو واجهات RPC جماعياً.

### DEFAULT PRIVILEGES — خطر وقائي مستقبلي

أظهر `pg_default_acl` أن مالكي الكائنات `postgres` و`supabase_admin` لديهم منح افتراضية واسعة لـanon وauthenticated على أنواع كائنات في `public`:
- الجداول: صلاحيات قراءة وكتابة وإدارة متعددة.
- الدوال: EXECUTE.
- sequences: SELECT/UPDATE/USAGE.

**لم يُثبت انكشاف حالي بسبب هذا الإعداد**؛ فالمسح المباشر وجد RLS مفعّلاً على جداول public الـ155 ولا يوجد جدول عام بلا RLS يمنح المتصفح وصولاً. لكنه خطر مستقبلي إذا أنشئت جداول أو دوال جديدة دون RLS/ACL صريح.

لا تنفذ `ALTER DEFAULT PRIVILEGES` على مستوى المشروع قبل جرد كل مسارات PostgREST المعتمدة وإعداد قائمة سماح صريحة؛ فقد يؤدي السحب الجماعي إلى تعطيل الوظائف المقصودة. المطلوب بناء guard آلي يمنع أي جدول عام جديد من البقاء بلا RLS، ويشترط ACL واضحاً لأي RPC جديد.

## 6. Supabase Advisors — آخر قراءة 7 نوفمبر

### Security

| التحذير | العدد | التفسير/التصرف |
|---|---:|---|
| RLS enabled, no policy | 64 | لا يظهر معها منح مباشر للمتصفح في الفحص الحي؛ لا تنشئ سياسات عامة لمجرد إزالة التحذير |
| Authenticated SECURITY DEFINER | 34 | واجهات RPC مقصودة؛ ACL يمنع anon/PUBLIC واختبارات الحدود موجودة |
| Extension in public | 1 | `pg_net`؛ النقل يحتاج فحص الاعتمادات قبل التغيير |
| Leaked password protection | 1 | إعداد Auth غير مفعّل؛ يلزم قرار/تفعيل إعداد موثق واختبار تدفق كلمات المرور |

### Performance

| التحذير | العدد | التصرف |
|---|---:|---|
| Foreign keys دون فهرس تغطية | 236 | لم تُضف فهارس جماعياً؛ ابدأ بالمسارات ذات القراءة/الحذف/الربط العالي |
| Unused indexes | 143 | لا تحذفها من إحصاءات Advisor وحدها؛ مدة الإحصاء وحجم الحمل قد لا يكونان كافيين |

الاختبارات #63 و#64 تثبت تغطية فهارس ساخنة معينة، لكنها لا تعني إغلاق كل 236 ملاحظة أو إثبات الأداء تحت حمل مماثل للإنتاج.

## 7. Production وVercel

### Supabase Production

- Project ID: `vvcdiqcyhaloxesvpppc`
- المنطقة: `ap-southeast-1`
- PostgreSQL: `17.6.1.155`
- الحالة عند آخر استعلام: `ACTIVE_HEALTHY`
- عدد الترحيلات: 486
- أحدث نسخة مسجلة: `20261026102654_powerhub_pin_subscription_lifecycle_search_path`

لم يتم تنفيذ اختبار وظيفي أو كتابة بيانات مالية على Production في هذه المرحلة. الاستعلام الذي تحقق من غياب Migration الجديدة كان قراءة لسجل الترحيلات فقط.

### Migration الجديدة

`20261107150000_powerhub_supplier_browser_read_acl_revoke`:
- Staging: غير مسجلة.
- Production: غير مسجلة.
- لا تطبق قبل مراجعة سجل الترحيلات ومطابقة الاسم النهائي، ثم موافقة/نافذة Staging المناسبة. لا Production.

### Vercel

- Production URL: `https://powerhub-platform.vercel.app`
- Project ID: `prj_uR7MwlpQQXIHvlBhAdXDYXZ7eaJO`
- لم يتم إنشاء Preview جديد ضمن إصلاح الموردين.
- لا تزال صلاحية `SUPABASE_SERVICE_ROLE_KEY` ضمن Preview غير قابلة للتحقق من قيمة المفتاح؛ لذلك لا يُسمح بإنشاء Preview أو Browser E2E اعتماداً على متغيرات غير مكتملة التحقق.

## 8. ما لم يُغلق بعد

1. إنشاء guard آلي دائم للـDEFAULT PRIVILEGES وRLS/ACL على الكائنات الجديدة؛ لا تغيير واسع حالياً.
2. مراجعة أجسام جميع SECURITY DEFINER الـ47، لا ACL وsearch_path فقط؛ راجع dynamic SQL، الهوية، مصادر الثقة، والاستدعاءات الداخلية. الواجهات الـ34 مغطاة بجزء كبير من الاختبارات، لكن هذا لا يغني عن مراجعة كل جسم.
3. تفعيل leaked password protection في Supabase Auth والتحقق من أثره.
4. تقييم نقل `pg_net` من public بناءً على الاعتمادات والـjobs.
5. فرز 236 FK بلا index إلى ساخن/بارد، ثم فحص EXPLAIN واستخدام فعلي؛ وعدم حذف 143 فهرساً دون قياس.
6. مراجعة بقية جداول RLS/الامتيازات خارج المجموعات التي لها اختبارات مخصصة.
7. تنفيذ/التحقق من Migration الموردين على Staging بعد المطابقة والاختبار والموافقة؛ لم تُطبق حتى الآن.
8. قياس الأداء تحت حمل واقعي للفروع والحسابات والتقارير.
9. التحقق من التنفيذ الفعلي لـCron تنظيف الصور ونتائجه، لا مجرد جدولته.
10. إثبات مفاتيح Vercel Preview الأربعة بأنها كلها Staging قبل Browser E2E.
11. إكمال Browser E2E لـLocal-First: online login، reload/reopen، offline-ready، reconnect، Delta، multi-tab، عدم إرسال طلبات محمية دون token صالح، وعدم مسح Outbox.
12. استكمال إصدار Android الميداني: منع القراءة المكررة للدورة، فلاتر المزامنة، حالة الاتصال، النصوص العربية، وRelease موقّع.
13. متابعة بقية ميزات PowerHub المؤجلة حسب الأولوية دون خلطها بإغلاق الأمان.

## 9. آلية متابعة تمنع إعادة التدقيق بلا سبب

قبل تعديل أي بند:
1. اقرأ هذا السجل.
2. تحقق من HEAD الحالي ورأس PR والـCI.
3. ابحث فقط عن تغييرات بعد SHA الذي أُغلق عليه البند.
4. أعد الفحص إذا تغير مصدر الحقيقة، أو Migration، أو ACL/RLS، أو ظهرت حالة فشل جديدة.
5. لا تعِد وصف بند مُثبت على أنه غير مراجع.

بعد أي Commit جديد:
1. حدّث SHA في سجل العمل.
2. شغّل الفحوص المطلوبة.
3. سجل كل workflow run وربطه بنفس SHA.
4. سجّل الخطوات الفاشلة/المتخطاة كما هي.
5. لا تنقل الحالة إلى «مكتمل» حتى تظهر SUCCESS.

**نقطة متابعة الكود عند إنشاء هذا السجل:** `2e3c5ad1336ea16ddf72ca62135343228d02f3fc`.  
أي Commit يوثق السجل سيغيّر HEAD ويستلزم إعادة تشغيل الفحوص على الرأس الجديد وفق ضابط المشروع.


---

## 10. تحديث 7 نوفمبر 2026 — بوابة DEFAULT PRIVILEGES ونتائج HEAD

**آخر SHA للكود قبل تحديث هذا السجل:**
`c19968025ddbc8468d76d467e2b42ab1958396ae`

الفرع ورأس PR #359 طابقا هذا الالتزام عند التحقق. حالة PR: OPEN + DRAFT + NOT MERGED.

### بوابات CI على SHA c199680

| الفحص | Run ID | النتيجة |
|---|---:|---|
| PowerHub CI | 42369924132 | SUCCESS |
| Reading Cycle PostgreSQL Integration | 42369924145 | SUCCESS |
| PowerHub Security | 42369924188 | SUCCESS |
| Supabase Admin Guard | 42369924138 | SUCCESS |
| PowerHub SBOM | 42369924165 | SUCCESS |

تفاصيل الوظائف:
- TypeScript, tests, production build: SUCCESS.
- PostgreSQL migration and assertions: SUCCESS.
- Dependency audit, dependency review, CodeQL: SUCCESS.
- Supabase runtime migration guards: SUCCESS.
- CycloneDX SBOM generation and validation: SUCCESS.

هذه النتائج تخص SHA أعلاه حصراً، ولا تنتقل إلى أي Commit لاحق.

### حارس DEFAULT PRIVILEGES

أضيفت الملفات التالية إلى CI:
- `scripts/check-supabase-default-privileges.mjs`
- `server/supabase-default-privileges-guard.test.ts`
- `supabase/tests/default_privileges_acl_guard.sql`

كما رُبط الفحص الثابت بـPowerHub CI، وربطت محاكاة PostgreSQL المعزولة بـReading Cycle PostgreSQL Integration.

الحارس الثابت:
- يفحص ترحيلات SQL المتغيرة مقابل الفرع الأساسي.
- يمنع منح DEFAULT PRIVILEGES إلى PUBLIC وanon وauthenticated.
- يمنع تعديل defaults الخاصة بمالك Supabase المُدار `supabase_admin`.
- لا يمنع منحاً صريحاً على كائن محدد، ولا يمنع REVOKE مدروساً.
- يتجاهل التعليقات والنصوص الحرفية والأجسام dollar-quoted عند تحديد أوامر SQL الفعلية.

اختبار PostgreSQL المعزول يحاكي inheritance غير الآمن للجداول والتسلسلات والدوال، ثم يثبت سحب ACL على مستوى الكائن، واستمرار صلاحيات الخدمة، وفعالية RLS على مستوى المستأجر.

**حدود الإثبات:** هذا الحارس يمنع إدخال أوامر ALTER DEFAULT PRIVILEGES الخطرة في الترحيلات الجديدة، والاختبار يثبت سلوك ACL في قاعدة اختبار مؤقتة. لا يغير pg_default_acl الحي في Staging أو Production، ولا يثبت وحده أن كل كائن جديد في Staging أو Production سيُفحص تلقائياً بعد إنشائه. لا تزال هناك حاجة إلى فحص catalog دوري/وقائي للكائنات الفعلية الجديدة.

### تصحيح نطاق جرد SECURITY DEFINER

أعيد فحص Staging للتمييز بين الدوال المكشوفة للمستخدم المصادق وكل الدوال المملوكة لـSECURITY DEFINER:

| المخطط | كل SECURITY DEFINER | القابلة للتنفيذ بواسطة authenticated |
|---|---:|---:|
| public | 295 | 34 |
| private | 54 | 13 |
| الإجمالي | 349 | 47 |

جميع الدوال الـ47 القابلة للتنفيذ بواسطة authenticated لديها إعداد search_path مثبت في لقطة الفحص.

الـ47 هي سطح الاستدعاء المباشر، وليست كل سلسلة التنفيذ. واجهات public البالغ عددها 34 تستدعي دوال private داخلية لا تمنح authenticated صلاحية EXECUTE مباشرة. لذلك يجب أن تشمل المراجعة أجسام الدوال الداخلية التي تستدعيها الواجهات، حتى لو لم تكن ضمن الـ47 مباشرة. لا يُسحب EXECUTE من هذه الدوال الداخلية جماعياً.

### مراجعة سلسلة الاستدعاء — المرحلة الأولى

تمت قراءة وفحص مجموعة من أجسام الدوال المرتبطة بالدردشة والدعم والإشعارات ومزامنة المولدات، بما فيها:
- إنشاء المحادثة والتحقق من عضوية المستأجر وميزة الدردشة.
- إرسال الرسائل، حدود الحجم، صلاحية المحادثة، reply target، Idempotency وحدود المعدل.
- الملاحظات الداخلية وصلاحية manageSupportChat.
- إسناد تذاكر الدعم وإدارة حالاتها وسجل الأحداث.
- قراءة/تحديث إيصالات الرسائل والإشعارات وربطها بالمستخدم.
- التحقق من صلاحية إدارة المولد حسب المستأجر والفرع والعضوية النشطة والملف الوظيفي والاستثناءات الفردية.

لم ينتج عن هذه القراءة وحدها تصريح بإغلاق كل الدوال أو كل سلاسل الاستدعاء. يلزم استكمال مراجعة بقية الأجسام واختبارات bypass والعضوية المنتهية وعزل المستأجر والفرع لكل واجهة ذات أثر.

### الحالة

- حارس الترحيلات الثابت: مضاف إلى CI ومجتاز على SHA c199680.
- اختبار ACL/RLS المعزول: مجتاز على SHA c199680.
- تغيير إعدادات DEFAULT PRIVILEGES الحية: لم ينفذ.
- Production: لم يتغير.
- مراجعة سلسلة الاستدعاء العابرة للواجهات: قيد الاستكمال.
- لا Migration جديدة مطلوبة لهذه البوابة حتى الآن.


---

## 11. تثبيت إصلاح DEFAULT PRIVILEGES — 7 نوفمبر 2026

### التسلسل التشخيصي

- SHA الفاشل: `153b11c35dfd5c0210e0e2625a2665891ad06f22`.
- Run الفشل: [PowerHub CI #42371852475](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42371852475).
- الوظيفة الوحيدة الفاشلة: `TypeScript, tests, and production build`.
- الخطوة الفاشلة: `Validate versioned Supabase migration release tooling`.
- سجل الخطوة يثبت السبب الدقيق: `SyntaxError: Invalid regular expression ... Unterminated group` في `scripts/check-supabase-default-privileges.mjs`. لم يكن فشل ترحيل أو اتصال بقاعدة البيانات.

### إصلاح Regex الأساسي ونتائجه

Commit: `2baf2ee0da69ba69c67fa30a175fcb124d8f9465`.

أُعيدت كتابة regex بعلامات هروب JavaScript صحيحة، بحيث لا تختلط كلمة ACL `REVOKE EXECUTE ON FUNCTIONS` مع PL/pgSQL dynamic `EXECUTE`.

البوابات الخمس جميعها SUCCESS على SHA نفسه:

| الفحص | Run ID | النتيجة |
|---|---:|---|
| PowerHub CI | 42372207180 | SUCCESS |
| Reading Cycle PostgreSQL Integration | 42372207228 | SUCCESS |
| PowerHub Security | 42372207197 | SUCCESS |
| Supabase Admin Guard | 42372207212 | SUCCESS |
| PowerHub SBOM | 42372207213 | SUCCESS |

تفاصيل التحقق: فحص إصدار/ترحيل Supabase، TypeScript، الاختبارات، وبناء الإنتاج نجحت. اختبارات PostgreSQL المعزولة نجحت كلها، ومنها الخطوة #87 الخاصة بمنع تسرب default privileges إلى كائنات public المستقبلية. وظائف CodeQL وDependency Review وDependency Audit نجحت. حارس Supabase وCycloneDX SBOM نجحا. لا توجد خطوة فاشلة أو متخطاة في قوائم الوظائف التي راجعتها.

### توسيع اكتشاف Dynamic SQL ونتائجه

Commit: `f5c3da174cd5ec498acdc14cf7fb08928af1757f`.

أضيف كشف أوسع لعبارات PL/pgSQL الديناميكية التي قد تستخدم متغيراً أو تعبير dollar-quoted، دون حصر المطابقة في `EXECUTE '...'` أو `EXECUTE format(...)` فقط. أضيف اختباران للانحدار:
- `EXECUTE command_text` مع متغير PL/pgSQL.
- `EXECUTE $sql$...$sql$` مع تعبير dollar-quoted.

البوابات الخمس جميعها SUCCESS على SHA نفسه:

| الفحص | Run ID | النتيجة |
|---|---:|---|
| PowerHub CI | 42372794523 | SUCCESS |
| Reading Cycle PostgreSQL Integration | 42372794593 | SUCCESS |
| PowerHub Security | 42372794512 | SUCCESS |
| Supabase Admin Guard | 42372794548 | SUCCESS |
| PowerHub SBOM | 42372794534 | SUCCESS |

تفاصيل الوظائف: `Validate versioned Supabase migration release tooling`، TypeScript، الاختبارات، وبناء الإنتاج كلها SUCCESS؛ PostgreSQL migration/assertions وجميع خطوات التكامل، بما فيها #87، SUCCESS؛ CodeQL وDependency Review وDependency Audit كلها SUCCESS؛ Supabase migration guard tests وCycloneDX generation/coverage/license validation كلها SUCCESS. لم تظهر خطوات فاشلة أو متخطاة في هذه التشغيلات.

### حدود الإثبات والسلامة

- نتائج كل SHA أعلاه مستقلة، ولا تُنقل إلى Commit لاحق.
- فشل #42371852475 مغلق على مستوى إصلاحه: SHA #2baf2ee0 اجتاز جميع البوابات الخمس، ثم SHA #f5c3da17 اجتازها أيضاً.
- اختبار PostgreSQL يعمل على قاعدة معزولة مؤقتة؛ لا يثبت وحده تعديل `pg_default_acl` الحي.
- لم تُطبق أي Migration أو تعديلات ACL/DEFAULT PRIVILEGES على Staging أو Production بسبب هذين الإصلاحين.
- لم يحدث أي تعديل مالي، أو إرسال SMS، أو حذف بيانات/ملفات حقيقية.
- PR #359 ما زال OPEN + DRAFT + NOT MERGED، ولا Force Push أو دمج.

### نقطة الاستكمال بعد هذا التوثيق

آخر SHA للكود قبل Commit التوثيق هذا هو `f5c3da174cd5ec498acdc14cf7fb08928af1757f`. تحديث هذا الملف سيولد SHA جديداً ويستلزم إعادة تشغيل البوابات الخمس عليه وفق سياسة المشروع. تبقى مراجعة أجسام SECURITY DEFINER وسلاسل الاستدعاء واختبارات تجاوز الصلاحيات عملاً منفصلاً؛ نجاح بوابات DEFAULT PRIVILEGES لا يعني إغلاق ذلك النطاق.


---

## 12. اختبار عزل الحسابات المالية ومراجعة هوية دعم المنصة — 7 نوفمبر 2026

### توسيع اختبار الحسابات المالية

Commit: `5d5d243de6d557bb387f35f3eb9a76eed8058316`.

تم تعديل `supabase/tests/financial_site_rls_scope.sql` فقط، دون تعديل migration أو قاعدة حية. أضيفت تأكيدات سلبية/إيجابية لقراءتي الحسابات عبر صلاحيتين مستقلتين:

- `viewFinancialReports`: يرى الحسابات 100 و102 و104 فقط، ولا يرى الحسابين 101 و103، ولا يرى روابط الفروع الأخرى.
- `manageExpenses` وحدها: النطاق نفسه للحسابات وروابط الفروع، ولا تمنح تلقائياً قراءة التسويات أو الفواتير أو المدفوعات.

التشغيل على SHA نفسه:

| الفحص | Run ID | النتيجة |
|---|---:|---|
| PowerHub CI | 42373981190 | SUCCESS |
| Reading Cycle PostgreSQL Integration | 42373981160 | SUCCESS |
| PowerHub Security | 42373981168 | SUCCESS |
| Supabase Admin Guard | 42373981140 | SUCCESS |
| PowerHub SBOM | 42373981141 | SUCCESS |

تفاصيل الوظائف:
- TypeScript وRun tests وBuild production artifacts: SUCCESS.
- PostgreSQL: جميع الخطوات SUCCESS. خطوة `Verify branch-scoped financial RLS, shared accounts, child rows, and privileged identities` انتهت برسالة `FINANCIAL_SITE_RLS_SCOPE_OK`.
- CodeQL وDependency Review وDependency Audit: SUCCESS.
- Supabase runtime migration guards: SUCCESS.
- CycloneDX generation وcoverage/license validation: SUCCESS.
- لا توجد خطوات فاشلة أو متخطاة في هذه التشغيلات.

### مراجعة مساعد هوية دعم المنصة

تمت قراءة تعريف `private.powerhub_has_platform_capability(text)` وACL وسياسات RLS ذات الصلة في Staging، ومقارنته مع `server/platform-admin.ts`.

نتيجة المقارنة:
- عقد الخادم `isActivePlatformSupport` يتطلب `users.role = 'admin'`، و`account_status = 'active'`، و`platform_role = 'platform_support'`.
- تعريف مساعد قاعدة البيانات المفحوص يتحقق من `auth.uid()` وحالة الحساب ودور المنصة، لكنه لا يتحقق من `users.role = 'admin'`.
- هذا اختلاف حقيقي في مصدر قرار التفويض، وقد يسمح لحساب عادي يحمل `platform_role='platform_support'` بالمرور إلى مسار RLS عند وجود capability مسموح، بينما يرفضه الخادم.
- لقطة Staging عند الفحص: لا توجد حسابات نشطة غير admin تحمل `platform_support`؛ أي إن الاختلاف وقائي ولم يُثبت وجود حساب حالي متأثر.
- لا يوجد دليل على استغلال أو وصول غير مصرح به حدث فعلاً.

### ما تم التحقق منه قبل اقتراح التغيير

- مساعد الحسابات المالية `private.powerhub_has_company_account_capability` استُخدم في سياسة RLS واحدة فقط لجدول `company_accounts`.
- لا توجد دوال أخرى في public/private تستدعي هذا المساعد.
- `authenticated` لا يملك CREATE على مخططي public/private.
- جميع المساعدات الـ47 القابلة للتنفيذ بواسطة authenticated لها `search_path` مثبت في لقطة Staging، ولا توجد ACL مباشرة لـanon أو PUBLIC ضمن هذه المجموعة.
- لا تغيير حي على الدوال أو ACL أو بيانات Staging.

### الإجراء المتبقي — P1

يلزم إنشاء migration أمامية جديدة تستبدل `private.powerhub_has_platform_capability(text)` وتضيف شرط `u.role='admin'` مع إبقاء `auth.uid()` و`account_status='active'` وACL و`search_path` الحاليين، ثم توسيع `supabase/tests/chat_support_admin_capability_scope.sql` ليشمل حالة سلبية: حساب `role='user'` مع `platform_role='platform_support'` يجب أن يُرفض. ويجب في المقابل أن يظل حساب platform_support النشط ذي `role='admin'` مسموحاً بالوصول المخصص للدعم.

لم تُنشأ migration ولم تُطبق على Staging أو Production حتى الآن. أداة Supabase CLI غير مثبتة في بيئة التنفيذ المحلية الحالية، لذلك لم أختلق timestamp لاسم migration ولم أعدل ملفاً تاريخياً. يجب إنشاء الملف بالأمر الرسمي `supabase migration new <name>` بعد توفير CLI، ثم فحصه في قاعدة PostgreSQL المعزولة قبل أي قرار بشأن Staging. Production خارج النطاق.

### الحالة ونقطة المتابعة

- الحسابات المالية المشتركة/المقيدة: اختبارات إضافية ناجحة على SHA `5d5d243`.
- mismatch هوية platform_support: `REQUIRES_FIX` — لم يُصلح بعد.
- عدم وجود حساب Staging نشط من نوع non-admin/platform_support: مثبت في لقطة القراءة وقت الفحص فقط، ولا يغلق فجوة الكود.
- آخر SHA كود اجتاز الفحوص الخمسة: `5d5d243de6d557bb387f35f3eb9a76eed8058316`.
- PR #359: OPEN + DRAFT + NOT MERGED.
- لم يحدث تطبيق migration أو تغيير ACL أو كتابة مالية أو إرسال SMS أو حذف ملفات حقيقية.


---

## 13. إغلاق فشل تضمين Migration وتثبيت هوية مسؤول الدعم — 7 نوفمبر 2026

### الرأس الذي خضع للتحقق

- Commit الكود: `55add4243f17d05a478c4114be2bf9a92eac4b56`.
- الرسالة: `fix(test): correct psql migration include escaping`.
- PR #359: OPEN + DRAFT + NOT MERGED.
- الفرع: `feat/auth-local-first-single-pr`.
- فحص Commit يثبت أن التغيير في هذا الالتزام اقتصر على ملف الاختبار `supabase/tests/chat_support_admin_capability_scope.sql`.

### تشخيص PostgreSQL وإغلاق سبب الفشل

- التشغيل السابق الفاشل: [Reading Cycle PostgreSQL Integration #42375647918](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42375647918).
- الخطوة: #80، اختبار Support Center admin RPCs.
- رسالة PostgreSQL الفعلية: `psql:supabase/tests/chat_support_admin_capability_scope.sql:84: error: invalid command \\\\\\\\ `.
- السبب: أمر تضمين psql كُتب بشرطتي backslash (`\\ir`) بينما صيغة psql الصحيحة تتطلب شرطة واحدة (`\ir`).
- إصلاح Commit `55add4243f17d05a478c4114be2bf9a92eac4b56`: تصحيح الأمر فقط، دون حذف الاختبار أو تغيير أي Assertion أو تخفيف ACL/RLS.
- التحقق من Diff Commit يؤكد أن السطر تغير من `\\ir ../migrations/20261107130443_powerhub_platform_support_identity_role_guard.sql` إلى `\ir ../migrations/20261107130443_powerhub_platform_support_identity_role_guard.sql`.

### تثبيت إصلاح هوية platform_support

تم التحقق من الملفين على Commit `55add424`:

- Migration: `supabase/migrations/20261107130443_powerhub_platform_support_identity_role_guard.sql`.
- Regression: `supabase/tests/chat_support_admin_capability_scope.sql`.

المساعد `private.powerhub_has_platform_capability(text)` يشترط الآن جميع ما يلي:
- الهوية مستمدة من `auth.uid()`.
- `users.role = 'admin'`.
- `account_status = 'active'`.
- `platform_role` ضمن القائمة المسموحة: `platform_owner` و`platform_admin` و`finance_admin` و`platform_support`.
- وجود سياسة capability صريحة ومسموحة للدور والقدرة المطلوبة.

ضوابط الدالة بقيت صريحة:
- `SECURITY DEFINER`.
- `search_path = ''`.
- المالك `postgres`.
- لا EXECUTE لـ`anon` أو `PUBLIC`.
- EXECUTE لـ`authenticated` يبقى قائماً لأنه مطلوب لاستدعاء مساعد RLS؛ ولا يُسحب جماعياً.

اختبار الانحدار يتضمن:
- رفض حساب عادي يحمل `platform_role='platform_support'` عند فحص capability.
- رفضه قراءة بيانات مركز الدعم غير النشطة أو إعدادات الدعم.
- رفض RPC الإداري له.
- السماح لحساب دعم حقيقي ذي `role='admin'` وحالة نشطة، مع التحقق من هوية منفذ العملية.
- رفض حساب الدعم الموقوف.
- رفض هوية JWT المفقودة ورفض anon وعدم السماح بكتابة مباشرة على جداول الإعدادات.

**هذا التحديث يحل التعارض التاريخي في القسم 12:** وصف `REQUIRES_FIX` وعبارة «لم تُنشأ migration» كانا يعكسان الحالة السابقة قبل إضافة Migration والاختبار. الحالة الحالية للكود هي `FIXED` ومختبرة في PostgreSQL المعزول، وليست مجرد توصية.

### البوابات الخمس على SHA واحد

كل تشغيل أدناه اكتمل `completed / success`، ورأس كل تشغيل يطابق SHA `55add4243f17d05a478c4114be2bf9a92eac4b56`:

| الفحص | Run ID | النتيجة |
|---|---:|---|
| Reading Cycle PostgreSQL Integration | 42376148889 | SUCCESS |
| PowerHub CI | 42376148814 | SUCCESS |
| PowerHub Security | 42376148916 | SUCCESS |
| Supabase Admin Guard | 42376148848 | SUCCESS |
| PowerHub SBOM | 42376148816 | SUCCESS |

تفاصيل PostgreSQL Integration:
- الوظيفة `Execute reading-cycle migration and assertions`: SUCCESS.
- #50 مساعدات هوية المنصة وحدود مسؤول المستأجر: SUCCESS.
- #51 تهيئة مسؤول المنصة المعتمد: SUCCESS.
- #52 نقل مسؤول المنصة: SUCCESS.
- #80 `Verify Support Center admin RPCs enforce manageSupportChat without direct table writes`: SUCCESS.
- #87 اختبار DEFAULT PRIVILEGES: SUCCESS.
- #89 `Verify platform-support capability requires active admin identity`: SUCCESS.
- لا توجد خطوات فاشلة في الوظيفة.

تفاصيل PowerHub Security:
- Dependency Audit: SUCCESS.
- Dependency Review: SUCCESS.
- CodeQL analysis: SUCCESS.
- لا تُسجل هذه النتائج بوصفها SKIPPED؛ الوظائف الثلاث اكتملت بنجاح في التشغيل الحالي.

### حدود الإثبات وسلامة البيئات

- نجاح PostgreSQL هو تنفيذ للاختبارات على قاعدة PostgreSQL مؤقتة/معزولة في CI.
- لا يُعد ذلك إثباتاً لتطبيق Migration الهوية على Staging أو Production؛ لا يوجد ضمن هذه البوابة ما يثبت تطبيقاً حياً، ولا يجوز استنتاجه من نجاح الاختبار.
- لم يحدث في هذه المرحلة تعديل لبيانات Production أو حركات مالية أو SMS أو حذف ملفات حقيقية.
- لا تغيير في حالة PR: يبقى OPEN + DRAFT + NOT MERGED.
- لم يستخدم Force Push ولم يحدث دمج.

### نقطة المتابعة بعد Commit التوثيق

- آخر SHA كود اجتاز البوابات الخمس قبل تحديث هذا السجل: `55add4243f17d05a478c4114be2bf9a92eac4b56`.
- إضافة هذا الملحق إلى السجل تنشئ Commit توثيقياً جديداً؛ لذلك يجب إعادة تشغيل البوابات المطلوبة وربط نتائجها بالـSHA الجديد قبل اعتباره رأساً متحققاً.
- مراجعة بقية أجسام SECURITY DEFINER وسلاسل الاستدعاء، وفحص DEFAULT PRIVILEGES الفعلي، والتدقيق المالي والأداء والقبول الحقيقي Offline/Browser ما زالت أعمالاً مستقلة ولم تُغلق بهذا التحديث.


---

## 14. فحص DEFAULT PRIVILEGES من pg_default_acl — 7 نوفمبر 2026

### دليل Staging المباشر (قراءة فقط)

أُعيد تنفيذ استعلام قراءة على مشروع Staging `iyuryuhaylhisjfcrwkz` مباشرةً من `pg_catalog.pg_default_acl`، مع توسيع ACL بواسطة `aclexplode` وربط المالك والمستفيد ونوع الكائن.

النتيجة في النطاق `public` للمالكين `postgres` و`supabase_admin`:
- رُصد 44 امتيازاً افتراضياً مفصلاً ممنوحاً إلى `anon` و`authenticated`.
- شملت المنح الجداول والتسلسلات والدوال.
- توزعت على المالكين الاثنين، والمستفيدين الاثنين، وأنواع الكائنات الثلاثة.
- ظهرت أيضاً منح `service_role` المقصودة، ولم تدخل ضمن عدد منح المتصفح.
- لم يظهر `PUBLIC EXECUTE` للدوال في النطاق المفحوص.

**التفسير:** هذه منح افتراضية مستقبلية، وليست دليلاً بحد ذاتها على أن الجداول الحالية مكشوفة. فحص الجداول والسياسات المباشر السابق ظل منفصلاً عنها. الخطر هو وراثة كائن عام جديد لهذه الامتيازات ما لم تُراجع ACL/RLS الخاصة به.

### تغيير الاختبار الفعلي

تم توسيع `supabase/tests/default_privileges_acl_guard.sql` ليقرأ `pg_catalog.pg_default_acl` مباشرةً في قاعدة PostgreSQL المؤقتة، ويثبت اكتشاف جميع التركيبات الاثنتي عشرة المتوقعة:
- مالكان: `postgres` و`supabase_admin`.
- ثلاثة أنواع: جداول `r`، تسلسلات `S`، دوال `f`.
- مستفيدان: `anon` و`authenticated`.

كما يثبت الاختبار أن `PUBLIC EXECUTE` غير موجود في الإعدادين العام والخاص بمخطط `public` لمالكي الاختبار. بقيت اختبارات وراثة الامتيازات على الكائنات الجديدة، وسحب امتيازات المتصفح على الكائنات التطبيقية، وحماية RLS وعمل `service_role` دون تخفيف.

تم توضيح اسم خطوة CI لتشير صراحة إلى اكتشاف Catalog إضافةً إلى تقوية ACL على الكائنات المستقبلية. ينفذ هذا التغيير ضمن خطوة PostgreSQL Integration القائمة، ولا ينشئ workflow منفصلاً.

### حدود التنفيذ

- تعديل SQL هنا اختبار انحدار معزول فقط، وليس Migration.
- لم تُعدّل `pg_default_acl` في Staging أو Production.
- لم تُطبق أي Migration أو ACL حيّة، ولم تُجرَ كتابة على بيانات الأعمال.
- لا يعني نجاح الاختبار المعزول أن المنح الافتراضية الحية قد أُصلحت؛ يتطلب ذلك خطة مستقلة تحافظ على الوظائف المقصودة وملكية `supabase_admin` المدارة، وموافقة مستقلة قبل أي تغيير حي.
- تُربط نتيجة هذا الفحص بالـSHA الجديد بعد اكتمال البوابات الخمس، ولا تُنقل نتائج SHA سابق إليه.


---

## 15. سلسلة استدعاء الحسابات المالية — تثبيت سياق SECURITY DEFINER في الاختبار المعزول — 7 نوفمبر 2026

### المراجعة المباشرة على Staging

أُعيد فحص جميع دوال `SECURITY DEFINER` التي يستطيع `authenticated` تنفيذها في مخططي `public/private`، مع ACL والمالك وإعداد `proconfig`، ثم فُحصت سلسلة الاستدعاء الداخلية للدوال المالية.

النتائج المرتبطة بهذا المسار:
- `private.powerhub_has_company_account_capability(bigint,bigint,text)` هي الدالة الوحيدة ضمن المجموعة المفحوصة التي ما زال `search_path` فيها غير فارغ: `pg_catalog, public, private, pg_temp`.
- الدالة لا تستخدم Dynamic SQL.
- جميع الجداول والدوال التي تستدعيها مؤهلة صراحةً بمخطط `public` أو `private`؛ لم يظهر في جسمها مرجع غير مؤهل لجدول أو دالة.
- مالك الدالة `postgres`، وهي `SECURITY DEFINER`، ولا تتيح EXECUTE لـ`anon` أو `PUBLIC`، وتُبقي EXECUTE لـ`authenticated` و`service_role` حسب العقد الحالي.
- تعتمد عليها سياسة SELECT واحدة لجدول `public.company_accounts`، إلى جانب `powerhub_has_company_account_access`، وتوجد اختبارات نطاق للفرعين والمستخدم المالك والعارض المالي ومدير المصروفات.

**التصنيف:** hardening follow-up، وليس دليلاً على استغلال قائم أو تجاوز صلاحيات مثبت. الجسم مؤهل بالمخطط بالكامل، لكن جعل `search_path` فارغاً يزيل الاعتماد على ترتيب مخططات البحث كطبقة دفاع إضافية.

### اختبار الانحدار المضاف

تم توسيع `supabase/tests/financial_site_rls_scope.sql` بعد تضمين Migration الحالية ليقوم الاختبار المعزول فقط بالآتي:
- يغيّر `search_path` للدالة داخل قاعدة الاختبار المؤقتة إلى `''`.
- يثبت `SECURITY DEFINER` ومالك `postgres` وإعداد `search_path=""`.
- يثبت عدم منح EXECUTE إلى `anon` أو `PUBLIC`.
- يثبت استمرار EXECUTE لـ`authenticated` و`service_role`.
- يواصل بعدها نفس اختبارات RLS للحسابات المشتركة والفرعين والصلاحيات المالية؛ وبالتالي يتحقق أن التشغيل تحت المسار الفارغ لا يكسر السلوك المالي المعتمد.

تم تحديث اسم خطوة PostgreSQL Integration القائمة لتعكس إضافة فحص سياق الدالة. لا توجد وظيفة CI جديدة ولا تشغيل توثيقي منفصل.

### حدود التغيير

- التعديل على `search_path` يحدث داخل قاعدة PostgreSQL المعزولة التي ينشئها CI فقط.
- إعداد Staging الحي للدالة ما زال `pg_catalog, public, private, pg_temp`؛ لم أغيّره ولم أطبق Migration على Staging.
- يلزم إنشاء Migration أمامية رسمية لتثبيت `SET search_path TO ''` في Staging مستقبلاً، باستخدام `supabase migration new` ومطابقة إصدارها مع سجل الترحيلات قبل التطبيق.
- Production لم يتغير. لم تحدث حركات مالية أو SMS أو عمليات حذف.

### بوابة الإغلاق

لا تُسجّل هذه الملاحظة على أنها إصلاح حي مكتمل. يغلق الاختبار المعزول جانب التوافق والسلوك، ويبقى التغيير الأمامي على Staging عملاً مستقلاً بموافقة وملف Migration رسمي. تُربط نتائج CI بالـSHA الجديد بعد اكتمال التشغيلات الخمس.


---

## 16. إصلاح فشل PostgreSQL في التحقق من PUBLIC EXECUTE — 7 نوفمبر 2026

### التشغيل الفاشل والتشخيص

- التشغيل: [Reading Cycle PostgreSQL Integration #42379474562](https://github.com/mosabmalek-rgb/powerhub-platform/actions/runs/42379474562).
- SHA: `b1ab4ff4cc6483726e96a6e4d98b2a5a9ef75fe5`.
- الوظيفة: `Execute reading-cycle migration and assertions`.
- الخطوة الفاشلة: `Verify branch-scoped financial RLS and hardened company-account capability context` (#61).
- الرسالة الدقيقة: `psql:supabase/tests/financial_site_rls_scope.sql:241: ERROR: role "PUBLIC" does not exist`.
- السبب: الاختبار مرر الكلمة `PUBLIC` إلى `has_function_privilege(text, ...)` كما لو كانت Role مسجلة. في PostgreSQL، `PUBLIC` ليس دوراً يمكن تمريره بهذه الطريقة؛ الامتياز الجماعي ممثل داخل ACL بالـgrantee OID = 0.

### الإصلاح

في `supabase/tests/financial_site_rls_scope.sql` تم استبدال استدعاء `has_function_privilege('PUBLIC',...)` بفحص صريح لـCatalog:
- قراءة `pg_proc.proacl` للدالة المستهدفة.
- استخدام `aclexplode(COALESCE(proacl, acldefault('f', proowner)))`.
- رفض وجود أي صف يحمل `grantee = 0` و`privilege_type = 'EXECUTE'`.
- الاستمرار في استخدام `has_function_privilege` للتحقق من الأدوار المسجلة فعلاً: `anon` و`authenticated` و`service_role`.

هذا يجعل الاختبار يقرأ تمثيل PostgreSQL الحقيقي لـPUBLIC بدلاً من محاولة التعامل معه كـRole، مع إبقاء شرط عدم منح PUBLIC EXECUTE أقوى وأكثر دقة.

### ما لم يكن سبباً للفشل

- نجح تنفيذ `ALTER FUNCTION ... SET search_path TO ''` داخل قاعدة الاختبار المعزولة قبل بلوغ التأكيد الفاشل.
- لا يثبت السجل أي خلل في دالة الصلاحيات نفسها أو في RLS أو في منطق عزل الحسابات.
- الفشل كان في صياغة Assertion الاختبارية حصراً؛ لم يتم حذفها أو تجاوزها.

### التحقق المطلوب

- إعادة تشغيل PostgreSQL Integration والبوابات الخمس على Commit الإصلاح الجديد.
- لا تُنقل نتيجة `05b9a132` أو أي SHA سابق إلى SHA الإصلاح.
- يظل تضييق `search_path` محصوراً في الاختبار المعزول حتى وجود Migration أمامية مستقلة ومراجعة؛ لم تتغير Staging أو Production.
- PR #359 يبقى OPEN + DRAFT + NOT MERGED.


---

## 17. تقوية search_path لمساعد صلاحيات الحساب المالي — 7 نوفمبر 2026

### التغيير المصدرّي

- أُنشئت Migration أمامية بواسطة الأمر الرسمي Supabase CLI: supabase migration new powerhub_company_account_capability_search_path.
- اسم الملف: 20261107143819_powerhub_company_account_capability_search_path.sql.
- تثبّت الدالة private.powerhub_has_company_account_capability(bigint,bigint,text) على search_path = ''.
- يتضمن الترحيل فحوصاً قبلية وبعدية تثبت وجود الدالة، وكونها SECURITY DEFINER، واحتفاظها بالمالك postgres، ومنع anon وPUBLIC EXECUTE، واستمرار EXECUTE لـauthenticated وservice_role.
- لا يعيد الترحيل إنشاء الدالة ولا يغيّر جسمها أو مالكها أو صلاحياتها؛ يضبط إعداد الدالة فقط.

### ربط اختبار الانحدار بالترحيل الفعلي

- يستورد supabase/tests/financial_site_rls_scope.sql ملف Migration الجديد باستخدام \ir.
- أُزيل ALTER FUNCTION اليدوي السابق من الاختبار حتى لا ينجح الاختبار دون تنفيذ ملف الشحن الفعلي.
- تستمر اختبارات عزل الفرع والحسابات المشتركة وصلاحيات مدير المصروفات والعارض المالي بعد تطبيق الترحيل في قاعدة الاختبار المعزولة.

### حدود التحقق والبيئات

- لم تُطبق Migration على Staging أو Production في هذا التغيير.
- آخر سجل Staging مؤكد قبل التطبيق ما زال 20261106224902؛ والملف الجديد موجود في PR فقط إلى أن يجتاز CI وتُراجع مطابقة ترحيلات Staging.
- لم تُجرَ حركات مالية أو رسائل SMS أو عمليات حذف.
- يجب ربط نتائج البوابات الخمس بالـSHA الجديد فقط. لا تُنقل نتائج ac1545ac08a84bc01322243aebf5ee4151463920 إلى Commit هذا الإصلاح.

### نتيجة التحقق المحلي بعد التغيير

- اكتمل اختبار supabase/tests/financial_site_rls_scope.sql بنجاح على قاعدة PostgreSQL مؤقتة جديدة باستخدام PostgreSQL 18، وظهرت علامة FINANCIAL_SITE_RLS_SCOPE_OK.
- شمل الاختبار استيراد Migration الجديدة فعلياً، ثم تشغيل اختبارات RLS للحسابات والفروع والمستخدمين ذوي القدرات المالية.
- أُعيد تشغيل ملف Migration منفرداً بعد الاختبار بنجاح؛ ضبط search_path قابل لإعادة التطبيق دون تغيير ACL.
- تحقق Catalog النهائي من المالك postgres، وSECURITY DEFINER = true، وsearch_path = ""، ومنع anon وPUBLIC EXECUTE، واستمرار authenticated وservice_role.
- هذا تحقق محلي على PostgreSQL 18؛ بوابة GitHub على PostgreSQL 17 مطلوبة على SHA النهائي ولا تُعد ناجحة بعد.


---

## 18. التحقق من اكتمال Migration المنشورة وإصلاح الاقتطاع — 7 نوفمبر 2026

أثناء تدقيق محتوى Commit `2614dbbd547102d225edd19bc265d5a3e037979a` مباشرةً من GitHub، تبيّن أن كائن Migration المنشور لم يتضمن كامل كتلة Postflight، رغم أن النسخة المحلية الكاملة كانت قد اجتازت الاختبار. لم أعتبر نتيجة الاختبار المحلي إثباتاً لسلامة الملف المنشور.

تم إصلاح الملف في هذا الالتزام اللاحق، مع إعادة نشر النص الكامل للترحيل والتحقق من وجود نهاية Postflight كاملة. النسخة النهائية المطلوبة يجب أن تجتاز من جديد اختبار PostgreSQL Integration على CI؛ تشغيلات الالتزام السابق لا تُستخدم لإثبات نجاح الالتزام المصحح.

لم يحدث تطبيق للترحيل على Staging أو Production خلال هذا التصحيح.

---

## 19. تقوية DEFAULT PRIVILEGES للكائنات المستقبلية — 7 نوفمبر 2026

### التشخيص ومراجعة حدود التأثير

أثبت الفحص المباشر في Staging `iyuryuhaylhisjfcrwkz` وجود منح افتراضية واسعة للمتصفح في `public` لكل من مالكي الكائنات `postgres` و`supabase_admin`. كما أظهر فحص `acldefault('f', owner_oid)` أن غياب سجل Global صريح في `pg_default_acl` لا يزيل `PUBLIC EXECUTE` الأساسي لدوال PostgreSQL الجديدة.

- يشمل جرد Staging 48 امتيازاً مفصلاً لـ`anon` و`authenticated` في إعدادات `public` للمالكين المذكورين، بما في ذلك امتياز `MAINTAIN` في PostgreSQL 17.
- لا تُعد `supabase_admin` مالكاً تديره Migration التطبيق؛ إعداداته تبقى منفصلة ولا تُعدّل.
- السحب العام لـ`PUBLIC EXECUTE` يؤثر في كل مخطط تُنشأ فيه دالة بواسطة `postgres`. لذلك يوقف الترحيل نفسه مسبقاً عند اكتشاف دوال مملوكة لـ`postgres` أو إعدادات افتراضية للدوال في مخططات لم تُراجع.
- فحوص ما قبل الترحيل للـStaging أعادت قوائم فارغة للدوال المملوكة لـ`postgres` خارج مجموعة المخططات المراجعة، ولإعدادات دواله خارج المخططات التي يعالجها الترحيل.

### Migration المرحلة الثانية

أُنشئت باستخدام Supabase CLI 3.0.0:

`supabase/migrations/20261107150951_powerhub_public_default_privilege_hardening.sql`

تُغيّر الافتراضيات للكائنات المستقبلية التي ينشئها `postgres` فقط:

- سحب كل امتيازات `anon` و`authenticated` الافتراضية عن الجداول والتسلسلات الجديدة في `public`.
- سحب `EXECUTE` الافتراضي عن `anon` و`authenticated` و`PUBLIC` للدوال الجديدة في `public`، مع إزالة `PUBLIC EXECUTE` من الافتراضي العام لمالك `postgres`.
- الحفاظ على امتيازات `service_role` الافتراضية المقصودة في `public`.
- إعادة سلوك `PUBLIC EXECUTE` المقصود لدوال `postgres` المستقبلية في `extensions` و`storage` و`pg_catalog` و`information_schema` حتى لا يتسبب السحب العام في تغيير جانبي غير مقصود هناك.
- لا تعدّل إعدادات `supabase_admin`، ولا تسحب أو تعيد كتابة ACL للكائنات الموجودة حالياً.
- تحتوي على Preflight وPostflight يفشلان بوضوح عند غياب الأدوار/المخططات المطلوبة أو بقاء المنح غير الآمنة.

### اختبار الانحدار المرتبط بملف الشحن

وُسّع `supabase/tests/default_privileges_acl_guard.sql` لبدء الحالة غير الآمنة في قاعدة اختبار مؤقتة، وإثبات أن سحب `PUBLIC EXECUTE` على مستوى المخطط وحده لا يلغي الافتراضي العام. بعد ذلك يستورد الاختبار ملف Migration نفسه باستخدام `\\ir`، ولا يضع الإصلاح العالمي يدوياً قبل الاختبار.

يغطي الاختبار:

- ACL للكائنات التي أُنشئت قبل Migration تبقى كما كانت.
- الجداول والتسلسلات والدوال الجديدة في `public` لا ترث امتيازات المتصفح غير المقصودة.
- استمرار الصلاحيات الافتراضية لـ`service_role`.
- إضافة `SELECT` صريح إلى `authenticated` واختبار RLS وعزل tenant.
- استمرار سلوك دوال `extensions` و`storage` المستقبلية.
- محاكاة `supabase_admin` والتأكد من عدم تغيير إعداداته المدارة.
- إعادة استيراد Migration نفسها، مع Snapshot لكافة سجلات `pg_default_acl` الخاصة بـ`postgres` ومقارنة قبل/بعد الإعادة باستخدام `EXCEPT` في الاتجاهين لإثبات عدم حدوث ACL drift.

### التحقق والبيئات

- نجح الاختبار محلياً على قاعدة PostgreSQL 18.6 جديدة ومعزولة وظهرت العلامة `DEFAULT_PRIVILEGES_ACL_GUARD_PASSED`.
- نجح اختبار إعادة تطبيق Migration ومقارنة ACL بعد الإعادة دون اختلاف غير مقصود.
- فحوص ما قبل الترحيل على Staging كانت للقراءة فقط؛ لم تُطبق Migration هناك.
- آخر سجل Staging مؤكد هو `20261106224902` بإجمالي 424 ترحيلاً.
- لم تتغير Production أو إعدادات Supabase الحية، ولم تُرسل رسائل SMS أو تُنشأ حركات مالية أو تُحذف ملفات.
- يلزم تشغيل PostgreSQL Integration على PostgreSQL 17 والبوابات الخمس كاملةً على SHA النهائي قبل اعتبار تغيير المصدر متحققاً.


### معالجة تعارض فحص الحماية في Commit اللاحق

كشف أول تشغيل CI بعد إضافة المرحلة الثانية أن بوابة `check-supabase-default-privileges.mjs` تمنع أي `GRANT EXECUTE ON FUNCTIONS TO PUBLIC` ضمن `ALTER DEFAULT PRIVILEGES`، بما في ذلك مخططات الامتدادات والنظام. لذلك أُلغي استثناء إعادة المنح للمخططات `extensions` و`storage` و`pg_catalog` و`information_schema`.

التصميم المصحح يسحب `PUBLIC EXECUTE` من الافتراضي العام لمالك `postgres`، ثم يستخدم أوامر `REVOKE` ثابتة ومراجَعة للمخططات `public` و`extensions` و`storage` و`pg_catalog` و`information_schema` لإزالة أي منح على مستوى المخطط، من دون SQL ديناميكي. لا تُعدّل ACL للدوال الموجودة، وتبقى منح `anon` و`authenticated` و`service_role` الصريحة والموجودة مسبقاً في إعدادات `storage` كما هي. عُدّل اختبار الانحدار ليثبت عدم منح `PUBLIC EXECUTE` للدوال المستقبلية في `extensions` و`storage`، مع المحافظة على منح `storage` الصريحة السابقة للأدوار، بدلاً من مطالبة الترحيل بإعادة منح `PUBLIC` التي تمنعها بوابة الأمان.


---

## 20. حماية أداة إطلاق الترحيلات من إعادة التنفيذ بسبب اختلاف timestamp — 7 نوفمبر 2026

### نتيجة مطابقة سجل Staging مع الفرع

أُعيدت مطابقة قائمة Staging (المشروع `iyuryuhaylhisjfcrwkz`) مع ملفات `supabase/migrations` على SHA `86298cdd31f2e7f753be546b6a9ed25039313520`:

- 424 ترحيلاً مسجلاً في Staging، وآخر إصدار `20261106224902`.
- 502 ملف Migration في الفرع.
- 179 زوجاً متطابقاً تماماً (version + name).
- 95 سجلاً يطابق اسم ملف محلياً لكن يختلف timestamp.
- 150 اسماً مسجلاً في Staging لا يوجد له ملف يحمل الاسم نفسه في الفرع الحالي.
- 5 أسماء مكررة داخل سجل Staging؛ منها `powerhub_image_retention_metadata` و`powerhub_chat_feature_entitlements`.
- توجد 7 ملفات محلية بعد آخر إصدار Staging، ولم يظهر اسم أي منها في السجل؛ لا يعني ذلك الإذن بتطبيقها قبل مراجعة سلسلة الترحيلات.

### فجوة أداة الإطلاق

كانت `scripts/release-supabase-migration.mjs` تتحقق من تطابق الإصدار فقط. إذا سُجل Migration باسم معين تحت timestamp آخر، كان بإمكان إصدارها المحلي المختلف أن يمر من هذا الفحص ويحاول إعادة تنفيذ SQL، رغم أن الاسم نفسه موجود في Staging.

### الحماية المضافة

أضيفت `classifySupabaseMigrationHistory` إلى `scripts/supabase-migration-target.mjs`، وربطت بأداة الإطلاق. أصبحت الأداة تفحص كل السجلات المطابقة للإصدار **أو الاسم** وتتصرف كالتالي:

- الزوج المتطابق تماماً: يعتبر مطبقاً ولا يعاد تنفيذه.
- الإصدار نفسه باسم مختلف: يرفض الإطلاق.
- الاسم نفسه بإصدار مختلف: يرفض الإطلاق ويطلب مطابقة السجل.
- الاسم المكرر في السجل: يرفض الإطلاق حتى تتم تسوية التاريخ.
- لا إصدار ولا اسم مطابقان: يسمح بالانتقال إلى بقية فحوص الإطلاق.

أضيفت اختبارات للحالات الفعلية التي كشفها Staging، بما فيها إعادة إصدار `powerhub_fuel_event_append_only_acl` وتكرار `powerhub_image_retention_metadata`.

لم تُطبق أي Migration على Staging أو Production أثناء هذا التدقيق.


---

## 21. إصلاح التحقق من تاريخ الترحيلات وقراءة سجل الإطلاق — 7 نوفمبر 2026

### السبب الجذري
كشف CI على Commit \`8b613f435bf9365c24b6d5796dca150b3336642b\` أن Regex التحقق في \`classifySupabaseMigrationHistory\` كان مزدوج الهروب، فرفض الإصدارات الصحيحة ذات 14 رقماً. أظهر سجل GitHub خمس حالات فشل من أصل 15 اختباراً لهذه العلة. نجحت بوابة PostgreSQL Integration وSecurity وAdmin Guard وSBOM على ذلك SHA.

### مشكلة قارئ السجل
أظهر فحص \`release-supabase-migration.mjs\` أن Regex تقسيم مخرجات \`psql\` كان مزدوج الهروب أيضاً؛ ما قد يدمج عدة سجلات في صف واحد ويضعف كشف الأسماء المكررة أو اختلاف timestamp.

### التصحيح
- تصحيح Regex الإصدار إلى \`/^\\d{14}$/\`.
- إضافة \`parseSupabaseMigrationHistoryRows\` لتقسيم LF وCRLF ورفض الصفوف المشوهة Fail-closed.
- استخدام المحلل المشترك داخل أداة الإطلاق.
- إضافة اختبارات للسجلات المتعددة والمخرجات الفارغة والصفوف المشوهة.
- توسيع اختبارات معرفات الإصدار غير الصحيحة.
- إدراج اختبارات \`scripts/**/*.test.mjs\` في Vitest وتشغيل ملف الحماية ضمن \`scripts/run-tests.mjs\`.

### حدود التنفيذ
لم تُطبق أي Migration على Staging أو Production، ولم تتغير ACL أو RLS أو بيانات. نتائج CI على Commit الإصلاح الجديد مطلوبة قبل اعتماد المرحلة. PR #359 يبقى OPEN وDRAFT وNOT MERGED.


---

## 22. Staging migration-history reconciliation and platform-support identity guard — 7 November 2026

A read-only comparison of the recursive Git tree at \`850144da0b8b7234f440a92da0739cc9f3142628\` against the live Staging migration ledger (\`iyuryuhaylhisjfcrwkz\`) recorded 502 local migration files and 424 Staging rows: 179 exact Version+Name matches, 91 same-name/different-version candidates, 232 local files with neither exact name nor matching version (225 at/before the Staging head and 7 newer), and 150 Staging rows / 149 unique names without an exact local filename match. Five duplicate-name groups were identified. This supersedes the earlier working estimate of 95 drift cases. A separate detailed report is stored at \`docs/security/powerhub-staging-migration-reconciliation-20261107.md\`.

The same live inspection confirmed that Staging's \`private.powerhub_has_platform_capability(text)\` still lacked the active \`users.role='admin'\` identity predicate, while the new migration \`20261107130443_powerhub_platform_support_identity_role_guard\` adds it. A new disposable PostgreSQL regression test now imports that exact migration and asserts:
- active platform support/admin and finance capability grants continue to work;
- a non-admin member with \`platform_role='platform_support'\` is denied;
- inactive admins, unallowlisted roles, and ungranted capabilities are denied;
- SECURITY DEFINER, empty search_path, postgres ownership, authenticated EXECUTE, and no anon/PUBLIC EXECUTE remain intact.

The test is added to the PostgreSQL Integration workflow. It has not yet run on a CI SHA at the time of this ledger entry. No live Staging or Production changes were made; migration history remains untouched and all seven newer migrations remain unapplied pending explicit review/approval.


---

## 23. Local migration-version inventory and protected release-source validation — 7 November 2026

### Findings at source HEAD \`ee957aad1503cfc2490fe14f0c866a9441c532a8\`

- The verified recursive Git tree contains 579 SQL migration files: 502 canonical 14-digit versioned files and 77 older numeric-version files. The previously reported 502 count remains the canonical inventory used for the 502-versus-424 reconciliation; GitHub comparison confirms no migration file changed between \`850144da0b8b7234f440a92da0739cc9f3142628\` and \`ee957...\`.
- Four additional 14-digit duplicate-version groups were inspected by file content, blob SHA, and Git path history: \`20260916190000\`, \`20260922123000\`, \`20260926123000\`, and \`20261013170000\`. Each pair contains distinct SQL behavior, not duplicate file content.
- Two older numeric-version collision groups, \`0010\` and \`0060\`, also exist.
- \`scripts/check-supabase-migration-files.mjs\` already pinned the exact six historical groups. Their filenames were deliberately left unchanged; timestamps derived from commit times alone would not prove migration-release order or historical database state.

### Release-workflow gap and hardening

The protected release workflow uses trusted scripts from \`main\` and checks out a PR source at its immutable SHA. Before this follow-up, it copied only the selected SQL file into the trusted workspace and ran the local inventory checker there. That meant an unselected migration in the same source PR could share a version without being inspected by the release inventory pass.

This follow-up closes that gap in source control:
- \`assertSupabaseMigrationFileInventory\` is shared by the local checker and release runner. It validates the full source tree, permits only the exact pinned six historical groups, and rejects every new or altered collision.
- \`assertSupabaseMigrationReleaseVersionIsUnique\` blocks a selected candidate if any other local file shares its version, even if the collision is one of the pinned historical groups.
- \`POWERHUB_MIGRATION_DIR\` points the checker and release runner to the complete immutable \`migration-source/supabase/migrations\` directory in the protected workflow.
- The release runner requires the selected migration to exist in that validated source inventory.
- Regression coverage verifies the pinned legacy groups, unknown duplicate versions, modified pinned groups, malformed names, missing candidates, and candidate-version uniqueness.

### Safety boundary

No migration filename or timestamp was rewritten. No \`db push\`, \`apply_migration\`, SQL DDL, ACL/RLS change, or migration-history write was executed. Staging remains at 424 recorded migrations with latest version \`20261106224902\`; Production remains untouched. The new code and documentation still require the five CI gates on their resulting commit SHA before this hardening is considered verified. The seven post-Staging migrations remain subject to separate content/dependency review and explicit Staging approval.


---

## 24. Staging migration SQL payloads — duplicate-name groups resolved by stored statements — 7 November 2026

A read-only catalog inspection found that supabase_migrations.schema_migrations includes statements text[], rollback text[], created_by, and idempotency_key. Although there is no dedicated checksum column, the SQL statements themselves are retained. The five duplicate-name groups were re-evaluated using statement byte lengths, server-computed MD5 fingerprints, exact/normalized Git source comparisons, live pg_proc.prosrc, and schema postconditions.

### Confirmed stored-payload classifications

| Name | Versions | Evidence | Result |
|---|---|---|---|
| powerhub_chat_helpdesk_v2 | 20260922090008 / 20260922090208 | First payload is exactly select 1; (9 bytes); second is 61,340 bytes and byte-for-byte equals the current Git migration. | No-op entry followed by the complete migration. |
| powerhub_reading_opening_baseline_save_fix | 20261010161951 / 20261010170812 | Two distinct payloads (4,657 / 5,036 bytes). The later function body matches both current Git source and live powerhub_create_reading. It adds tenant+subscriber-scoped idempotency lookup and opening-baseline previous-value fallback. | Later revision is the current effective function body. |
| staging_restore_powerhub_submit_payment_documentation_source_destination_support_v2 | 20261012174547 / 20261012174856 | Two distinct payloads (6,831 / 6,955 bytes). Later version adds the destination-account site-mapping guard. Live function includes it plus a subsequent actor_tenant_role audit extension. | Distinct restore revisions; live function is later than both. |
| powerhub_image_retention_metadata | 20261101200609 / 20261102171227 | 733 / 734 bytes; normalized SQL identical; second payload exactly equals current Git migration. | Same normalized metadata SQL replayed. |
| powerhub_chat_feature_entitlements | 20261101210557 / 20261102171243 | Both 21,410 bytes, same MD5, and each is byte-for-byte equal to current Git migration. | Exact SQL replay. |

### Runtime observations

- Chat Helpdesk tables, columns, support RLS policies and core helper functions are present. However, Staging's cron.job currently contains only powerhub_reconcile_expired_field_readers and powerhub-subscription-lifecycle; there is no powerhub_chat_sla job. SLA/auto-close functions exist, but Staging's PostgreSQL SLA schedule is not active in this snapshot. Check non-Postgres schedulers separately.
- Reading creation remains SECURITY INVOKER, owner postgres, with pinned search_path=public, pg_temp; current function source matches the later stored migration body.
- Payment documentation submission remains SECURITY INVOKER, owner postgres, with pinned search_path=public, pg_temp; its ACL is limited to postgres and service_role. The live function includes destination site-scope validation and later tenant-role audit attribution.
- Image-retention metadata columns/index and claim/finish RPCs exist. There is no matching retention/image pg_cron job in Staging; Vercel/Edge scheduling was not ruled out by this SQL-only inspection.
- Chat/AI feature catalog rows are active and server-enforced, with 10 add-on package-policy entries. There are no explicit tenant_feature_controls override rows for those feature keys in the current Staging snapshot.

### Decision and scope

The five duplicate-name groups are content-classified without rewriting their version history. Existing release guards should continue rejecting same-name duplicate candidates rather than silently treating duplicate ledger rows as a clean migration identity. The other 91 same-name/different-version candidates remain open and must be checked against their own stored statements payloads.

No SQL was applied, no row in schema_migrations was changed, no ACL/RLS or business data was changed, no retention deletion was run, no real SMS/financial operation was created, and Production was not accessed or modified. Staging remains at 424 rows, latest 20261106224902. The five CI gates must be rerun on the documentation commit SHA.
