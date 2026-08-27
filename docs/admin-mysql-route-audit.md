# جرد مسارات MySQL في راوتر الإدارة العليا

**النطاق:** `server/admin.ts` بعد نقل قراءات الإعدادات والتنظيفات المحلية الأخيرة. هذا الجرد توثيق داخلي فقط؛ لا يعني أن الترحيل الكامل أو التحقق الإنتاجي قد اكتمل.

## القراءات الخاضعة للحصر

| المسار | الحالة الحالية | التصنيف | المعالجة المطلوبة |
|---|---|---|---|
| `platformTweetSmsReport` | Supabase | تقرير مجمّع مركزي | نُقل إلى `powerhub_tweetsms_report`، وهي دالة PostgreSQL للقراءة فقط مع نطاق تاريخ اختياري؛ لا اتصال بمزود خارجي. |
| `financeOverview` | Supabase | ملخص مالي مركزي | نُقل إلى `powerhub_finance_overview`، وهي دالة PostgreSQL للقراءة فقط مقيدة بحارس `platformFinanceProcedure` وبصلاحية `service_role` فقط. |
| `operationalMonitoring` | Supabase | مراقبة مركزية وتجميع حالات | نُقلت القوائم المحدودة والعدادات إلى Supabase، من دون تشغيل رسائل أو مهام مجدولة. |
| `advancedDashboard` | Supabase | لوحة تحليلات متعددة الجداول | نُقلت إلى `powerhub_advanced_dashboard`، وهي دالة PostgreSQL للقراءة فقط مع مؤشرات ورسوم وقوائم محدودة، ومقيدة بحارس مدير المنصة. |
| `globalSearch` | Supabase | بحث مركزي محدود | نُقل البحث المحدود إلى Supabase مع تطبيع مدخلات البحث وإرجاع الأسماء ضمن المستأجر الصحيح. |
| `generatorDetails` | Supabase | تفاصيل مولد وسجل نشاط | نُقلت قراءة المولد وسجل التدقيق المرتبط به إلى Supabase مع جلب الأسماء المرجعية المحدود. |

## الكتابات المتبقية

| مجموعة العمليات | المسارات | التصنيف | المعالجة المطلوبة |
|---|---|---|---|
| الترقية والاشتراكات | `reviewSubscriptionUpgradeRequest`, `quickUpgradeOwnerPlan`, `updateSubscription`, `renewSubscription` | متعددة الجداول وتؤثر في حدود الباقة | **موقوفة صراحةً** قبل MySQL؛ يلزم RPC PostgreSQL ذرية بقفل وتدقيق لإعادتها. |
| وصول إدارة المنصة | `invitePlatformAccess`, `setPlatformAccountStatus`, `setPlatformAccessRole` | تتصل بالهوية والصلاحيات | **موقوفة صراحةً** قبل MySQL؛ يلزم تصميم Supabase Auth قابل للتعويض وRPC للتدقيق لإعادتها. |
| وصول المستأجر والمالك | `inviteTenantAccess`, `setTenantMembershipStatus`, `createGeneratorOwner`, `attachOwnerUser` | Auth وعضوية وفروع ومولدات | **موقوفة صراحةً** قبل MySQL؛ يلزم RPC + سجل نية وتعويض Auth لإعادتها. |
| باقات SMS | `createSmsPlan`, `updateSmsPlan`, `reviewSmsPackageRequest` | حصة رسائل وتدقيق | **موقوفة صراحةً** قبل MySQL؛ يلزم RPC PostgreSQL ذرية مع بقاء الإرسال الخارجي معطلاً. |
| الشكاوى والتسعير والإعدادات | `updateComplaint`, `createTariffPolicy`, `saveTenantBranchSettings`, `savePlatformSetting`, `requestOwnerAccessRecovery`, `saveRolePolicy` | كتابة سجل واحد أو أكثر مع تدقيق | **موقوفة صراحةً** قبل MySQL؛ يلزم RPC PostgreSQL ذرية لإعادتها، ولا تُستبدل بسلاسل PostgREST غير ذرية. |

## مسارات منقولة أو محمية بالفعل

انتقلت قراءات المالكين واللقطة المركزية ودليل المستخدمين وقوائم TweetSMS وتقريرها المركزي وطلبات ترقية الباقات وقوائم باقات وطلبات SMS وسجل الإشعارات ومركز الأمان والإعدادات وسياسات الأدوار وقائمة التسعير والشكاوى وإعدادات الفروع ودليل وصول آدمن المنصة والبحث العالمي والمراقبة التشغيلية وتفاصيل المولد والملخص المالي المركزي إلى Supabase. كما أزيلت بدائل MySQL غير القابلة للوصول من قارئتي حسابات TweetSMS وطلبات حزم الرسائل. العمليات الخارجية الخاصة برسائل SMS/WhatsApp واختبار مزودي الرسائل محمية برسائل إيقاف صريحة ولا تنفذ اتصالاً خارجياً أثناء الترحيل.

> يثبت الجرد النهائي أن **لا قراءة تشغيلية قابلة للوصول** في `server/admin.ts` تستدعي `dbOrThrow`. مواضع الاستدعاء المتبقية كلها كتابات موروثة، ويسبق كل موضع منها `assertLegacyAdminWriteMigrationGuard` الذي يوقف العملية في بيئة التشغيل الاعتيادية قبل الوصول إلى MySQL. لا يُعاد تمكين أي كتابة منها إلا بعد نقلها إلى RPC PostgreSQL ذرية مع سجل تدقيق وتعويض مناسب عند الحاجة.
