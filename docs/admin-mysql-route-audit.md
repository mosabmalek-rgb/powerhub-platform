# جرد مسارات MySQL في راوتر الإدارة العليا

**النطاق:** `server/admin.ts` بعد نقل قراءات الإعدادات والتنظيفات المحلية الأخيرة. هذا الجرد توثيق داخلي فقط؛ لا يعني أن الترحيل الكامل أو التحقق الإنتاجي قد اكتمل.

## القراءات المتبقية

| المسار | الحالة الحالية | التصنيف | المعالجة المطلوبة |
|---|---|---|---|
| `platformTweetSmsReport` | MySQL | تقرير مجمّع مركزي | نقل تجميع الاستهلاك والتنبيهات إلى قراءة Supabase محدودة أو دالة PostgreSQL للقراءة فقط؛ لا اتصال بمزود خارجي. |
| `financeOverview` | MySQL | ملخص مالي مركزي | نقل الإجماليات إلى دالة PostgreSQL للقراءة فقط، مقيدة بحارس `platformFinanceProcedure`. |
| `operationalMonitoring` | MySQL | مراقبة مركزية وتجميع حالات | نقل القوائم المحدودة والعدادات إلى Supabase، مع عدم تشغيل رسائل أو مهام مجدولة. |
| `advancedDashboard` | MySQL | لوحة تحليلات متعددة الجداول | نقلها إلى استعلامات Supabase مقيدة أو دالة PostgreSQL للقراءة فقط، مع الحفاظ على نطاق مدير المنصة فقط. |
| `globalSearch` | MySQL | بحث مركزي محدود | نقل البحث المحدود إلى Supabase مع تطبيع/هروب مدخلات البحث وإرجاع الأسماء ضمن المستأجر الصحيح. |
| `generatorDetails` | MySQL | تفاصيل مولد وسجل نشاط | نقل قراءة المولد وسجل التدقيق المرتبط به إلى Supabase مع جلب الأسماء المرجعية المحدود. |

## الكتابات المتبقية

| مجموعة العمليات | المسارات | التصنيف | المعالجة المطلوبة |
|---|---|---|---|
| الترقية والاشتراكات | `reviewSubscriptionUpgradeRequest`, `quickUpgradeOwnerPlan`, `updateSubscription`, `renewSubscription` | متعددة الجداول وتؤثر في حدود الباقة | RPC PostgreSQL ذرية بقفل وتدقيق، أو إيقاف صريح قبل MySQL. |
| وصول إدارة المنصة | `invitePlatformAccess`, `setPlatformAccountStatus`, `setPlatformAccessRole` | تتصل بالهوية والصلاحيات | تصميم Supabase Auth قابل للتعويض وRPC للتدقيق، أو إيقاف صريح قبل MySQL. |
| وصول المستأجر والمالك | `inviteTenantAccess`, `setTenantMembershipStatus`, `createGeneratorOwner`, `attachOwnerUser` | Auth وعضوية وفروع ومولدات | RPC + سجل نية وتعويض Auth، أو إيقاف صريح قبل MySQL. |
| باقات SMS | `createSmsPlan`, `updateSmsPlan`, `reviewSmsPackageRequest` | حصة رسائل وتدقيق | RPC PostgreSQL ذرية، مع بقاء الإرسال الخارجي معطلاً. |
| الشكاوى والتسعير والإعدادات | `updateComplaint`, `createTariffPolicy`, `saveTenantBranchSettings`, `savePlatformSetting`, `requestOwnerAccessRecovery`, `saveRolePolicy` | كتابة سجل واحد أو أكثر مع تدقيق | RPC PostgreSQL ذرية أو إيقاف صريح قبل MySQL؛ لا سلاسل PostgREST غير ذرية. |

## مسارات منقولة أو محمية بالفعل

انتقلت قراءات المالكين واللقطة المركزية ودليل المستخدمين وقوائم TweetSMS وطلبات ترقية الباقات وقوائم باقات وطلبات SMS وسجل الإشعارات ومركز الأمان والإعدادات وسياسات الأدوار وقائمة التسعير والشكاوى وإعدادات الفروع ودليل وصول آدمن المنصة إلى Supabase. كما أزيلت بدائل MySQL غير القابلة للوصول من قارئتي حسابات TweetSMS وطلبات حزم الرسائل. العمليات الخارجية الخاصة برسائل SMS/WhatsApp واختبار مزودي الرسائل محمية برسائل إيقاف صريحة ولا تنفذ اتصالاً خارجياً أثناء الترحيل.

> لا يُغلق بند الترحيل الشامل للراوتر إلا بعد معالجة جميع الصفوف في الجدولين السابقين، ثم إعادة الجرد بدون أي استدعاء قابل للوصول إلى `dbOrThrow` داخل إجراءات التشغيل الفعالة.
