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
