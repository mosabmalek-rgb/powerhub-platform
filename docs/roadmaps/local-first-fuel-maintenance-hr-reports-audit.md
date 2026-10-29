# تدقيق تغطية Local-First / Delta — الوقود والصيانة والموارد البشرية والتقارير

- **الحالة:** تدقيق نطاق أولي موثّق؛ لا يعني أن المجالات أدناه مكتملة أو مقبولة تشغيليًا.
- **التاريخ:** 2026-10-29
- **الفرع:** `feat/auth-local-first-single-pr` (PR #359).
- **قاعدة السلامة:** لا نشر Preview أثناء استكمال التبويبات، ولا تطبيق migrations أو تغييرات RLS على أي بيئة ضمن هذا التدقيق.

## نتيجة التدقيق من سياسة العميل الحالية

| المجال | ما تغطيه البنية الحالية | الفجوة / قرار الكاش الحالي | الحالة |
|---|---|---|---|
| الوقود | `fuel_readings` حتى 500 سجل؛ أضيف `fuel_events` حتى 500 سجل خادميًا و100 في استعلام العرض المحلي، مع إسقاط لا يتضمن تكاليف التعبئة أو الملاحظات. | سجل التعبئة المفلتر حسب التاريخ/المولد والتقارير المحسوبة والتنبيهات ليست Delta feeds؛ التقرير المحسوب له لقطة محلية منفصلة لمدة 24 ساعة وبنطاق المستخدم/الفرع/الفلاتر. | جزئي — القراءات والتعبئات الحديثة فقط |
| الصيانة | `maintenance_preventive_plans` حتى 500؛ أضيف `maintenance_work_orders` حتى 200 أمر حديث، وfeed مستقل `maintenance_work_order_parts:<workOrderId>` يزامن قائمة القطع كاملة لكل أمر. | تقرير الصيانة حسب المولد ليس Delta feed؛ له لقطة تجميعية محلية لمدة 24 ساعة مطابقة للمستخدم/الفرع/الفلاتر. يلزم اجتياز CI وتكامل SQL قبل قبول التنفيذ. | جزئي — الأوامر والقطع والخطط، مع تقارير مجمعة مخزنة منفصلًا |
| الموارد البشرية | سياسة الكاش تحجب صراحةً `hr` و`payroll` و`attendance`، وتغطي الاختبارات `hr.listEmployees` و`hr.listAttendance` و`hr.listPayrollRuns` و`hr.getPayrollDetails`. | لا يوجد feed Delta للدوام أو الرواتب، كما أن سجل الموظفين يحوي الهوية والهاتف والأجر والملاحظات. لا تُخزّن هذه البيانات حتى اعتماد إسقاط محدود وصلاحيات ونطاق ومسح مثبتة. | غير مكتمل — محجوب عمدًا |
| التقارير | لقطات Dashboard محدودة؛ أضيفت لقطات تجميعية منفصلة لتقرير الوقود وتقرير الصيانة لمدة 24 ساعة، بمفتاح يضم المستخدم والفرع ونوع التقرير والفلاتر. | التقارير المحفوظة ليست Delta feeds ولا يعاد احتسابها محليًا؛ تعرض الواجهة تاريخ اللقطة وتوضح أنها ليست نتيجة حية. تبقى صلاحية التصدير مشروطة بوجود بيانات حية أو لقطة صالحة. | جزئي — لقطات تجميعية فقط |

## ضوابط التنفيذ المطلوبة

1. **الوقود:** تتبع مصدر كل استعلام فعلي في شاشة الوقود (حركات التعبئة، قياسات الخزان، ساعات التشغيل، الاستهلاك، والتنبيهات). فصل السجلات الخام عن التقارير المحسوبة. لا تُنشأ قيمة استهلاك أو لتر/ساعة من بيانات ناقصة؛ يجب أن يعيد الخادم حالة صريحة عند نقص القراءات أو وجود عدم تطابق.
2. **الصيانة:** تحديد الجداول وعمليات القراءة الفعلية وسلوك الأرشفة/الحذف. لا يُضاف نوع إلى قائمة العميل وحدها؛ يلزم إسقاط خادمي allowlisted، وسجل تغييرات مع tombstones، واختبار SQL للتحديث والحذف وعزل المستأجر/الفرع، ثم projection يطابق شكل استعلامات الواجهة.
3. **الموارد البشرية:** جرد الدوام والورديات والإجازات والرواتب والسلف/الاستقطاعات إن كانت ضمن الصفحات. لا تُخزّن تفاصيل الرواتب محليًا قبل مراجعة الحساسية، والصلاحيات، وعزل المستخدم/الفرع، وسياسة مسح البيانات عند تبديل الحساب. يمكن البدء بملخصات غير حساسة فقط إذا كان لها عقد خادمي صريح.
4. **التقارير:** تصنيف كل تقرير إلى (أ) لقطة عرض قابلة للكاش، (ب) تقرير قابل لإعادة البناء من Delta محددة، أو (ج) نتيجة حساسة/حساب خادمي يجب التحقق منها عند الاتصال. لا تستخدم `Infinity` stale time دون Delta reconciliation مثبتة أو آلية revision موثوقة.
5. **كل المجالات:** cache key وcursor يجب أن يشملا هوية المستخدم والمستأجر والفرع ونوع الكيان. يجب أن تعالج المزامنة upsert والحذف/الأرشفة والتغييرات في نطاق الوصول. تبقى العمليات المالية أو الحساسة خادمية ولا يُعرض نجاح نهائي قبل تأكيد الخادم.
6. **القبول:** اختبارات unit/contract، وتكامل PostgreSQL مع تغييرات وحذف وعزل بين مستأجرين، ثم CI كامل على SHA النهائي. بعد إكمال جميع التبويبات فقط، يجري اختبار متصفح شامل ومعاينة واحدة وفق موافقة المستخدم. لا تُعد استجابة `/api/health` أو نجاح البناء دليلًا على صحة تسجيل الدخول أو عرض البيانات.

## ترتيب التنفيذ المقترح

- **F1 — الوقود:** توجد feeds للقراءات والتعبئات الحديثة؛ سجل التعبئة المفلتر والتقارير المحسوبة والتنبيهات تبقى خارج Delta. التقرير المحسوب يُخزّن كلقطة تجميعية منفصلة بنطاق وفترة دقيقين. عولجت عضوية أحدث 500 قراءة في مصدر Delta: حذف قراءة أو تغيير `recorded_at` يعيد إرسال النطاق الحالي كي لا يبقى الصف رقم 501 مخفيًا بعد حذف صف مرئي. وتُقلّص IndexedDB الآن sidecar الوقود إلى 500 في المعاملة نفسها مع المؤشر.
- **M1 — الصيانة:** توجد feeds للخطط والأوامر الحديثة وقطع كل أمر بنطاق مستقل. التقرير حسب المولد يُخزّن كلقطة تجميعية منفصلة. عولجت عضوية أعلى 500 خطة عند الحذف أو تغيير `next_due_at` أو أولوية التنبيه، مع إعادة ملء النطاق وإزالة الصفوف الخارجة من sidecar في معاملة تحديث المؤشر. لا يُطبق حد عام على قطع أمر الصيانة؛ تبقى القائمة كاملة لكل `workOrderId`. يلزم نجاح اختبارات PostgreSQL وCI على الرأس النهائي.
- **R1 — التقارير:** مصفوفة تقرير-بـ-تقرير مع freshness/revision واضحة؛ لا كاش عام لكل استعلامات التقارير.
- **H1 — الموارد البشرية:** يبدأ بعد مراجعة الحساسية والصلاحيات؛ تبقى الرواتب والدوام محجوبة من الكاش حتى اكتمال عقد آمن واختباراته.
- **بوابة نهائية:** تدقيق التغطية لكل تبويب، ثم جميع الاختبارات وCI على رأس واحد، ثم معاينة واحدة بعد انتهاء النطاق كله.

## ما لم يُثبت بهذا التدقيق

لم تُشغّل اختبارات متصفح، ولم تُجرَ تغييرات قاعدة بيانات، ولم تُطبّق migrations، ولم يُنشر Preview جديد. هذا المستند يسجل فجوات ظهرت من عقد سياسة الكاش وأنواع Delta الحالية؛ يجب إكمال تتبع استعلامات الصفحات ومخطط قاعدة البيانات قبل ادعاء اكتمال أي مجال.


## متابعة التنفيذ بعد التدقيق الأولي

- **الوقود:** يوجد الآن feed Delta محدود لقراءات الخزان/ساعات التشغيل (`fuel_readings`) مع لقطة خادمية لا تتجاوز 500 سجل، لكن سجل التعبئة (`listFuelEvents`) وتقارير الاستهلاك المحسوبة والتنبيهات ما زالت خارج Delta. تبقى اختبارات السياسة مانعة لتخزين هذه الاستعلامات كأنها Delta-backed.
- **الصيانة:** يوجد الآن feed Delta محدود للخطط الوقائية والتنبيهات (`maintenance_preventive_plans`) بحد خادمي ومحلي قدره 500 سجل مع أولوية للمتأخر ثم الأقرب موعدًا. عند تغيّر تنبيه يعاد بث الإسقاط الحالي ضمن أفضل 500 لتحديث عضوية المجموعة وملء أي مقعد خرج منه سجل؛ يظل هذا تغييرًا يحتاج اجتياز CI، ولا يعني اختبارًا تشغيليًا حيًا على قاعدة البيانات. أوامر العمل والقطع والتقرير حسب المولد ما زالت بلا feed Delta مستقل، ولا تُعامل إعادة جلبها بفاصل قصير على أنها مزامنة تفاضلية.
- **الموارد البشرية:** الاختبارات تستهدف أسماء إجراءات الواجهة الحقيقية (`hr.listEmployees`, `hr.listAttendance`, `hr.listPayrollRuns`, `hr.getPayrollDetails`) وتثبت بقاءها خارج الكاش العام. يجب أن يستمر هذا الحظر حتى اعتماد تصميم صريح لتخزين ملخصات آمنة فقط، إن لزم.
- **التقارير المالية:** تمت معالجة فجوة في التخزين المحلي الخاص بالتقارير: أصبح الإسقاط المحفوظ يقتصر على `range` و`summary` و`scope` و`branchSummaries`، ويستبعد أسماء المدينين وتفاصيل الدفعات وأسماء المحصلين. كما أصبح العرض المحلي مشروطًا بتطابق المستخدم والفرع والنطاق والفترة، وحداثة اللقطة، وعدم وجود رفض صلاحيات معروف. أضيفت اختبارات لهذه الشروط.
- **حدود القبول:** أضيفت اختبارات انحدار للانتقال خارج حد 500 وملء البديل بعد حذف قراءة/خطة، وتُختبر الآن داخل PostgreSQL disposable. لم يُثبت اكتمال التنفيذ حتى تجتاز جميع الفحوص على رأس نهائي واحد، مع اختبار SQL للتحديث والحذف والعزل. بيانات الموارد البشرية ما زالت خارج الكاش العام، ولم تُنشر معاينة.


- **متانة IndexedDB للتقارير:** أصبحت عمليات القراءة/الكتابة لا تُعد ناجحة إلا بعد اكتمال المعاملة، ويجري تنقية اللقطات القديمة عند قراءتها حتى لا تستمر تفاصيل حساسة محفوظة من إصدار سابق. هذا تغيير في سلوك التخزين المحلي فقط؛ يحتاج إلى اجتياز CI قبل اعتباره مقبولًا.


## متابعة فجوة عضوية أوامر الصيانة — 2026-10-29

- **الفجوة المثبتة:** كان حذف أمر صيانة من أحدث 200 أو نقله خارج نطاق الفرع لا يضمن إعادة إرسال السجل الذي كان في المرتبة 201. tombstone وحده يحذف الصف ولا يملأ المقعد، وقد تبقى القائمة المحلية أقصر من الحد أو لا تحتوي البديل حتى إعادة بناء اللقطة.
- **المعالجة المضافة في PR #359:** أضيفت الدالة `powerhub_refresh_maintenance_work_order_delta_scope` لإعادة إرسال أحدث 200 أمر بعد حذف أمر، أو نقل أمر بين نطاقات tenant/site، أو تغيير `reported_at`. الترتيب يستخدم `coalesce(reported_at, created_at) DESC, id DESC`، ويظل حد 200 محفوظًا.
- **اختبار الانحدار المضاف:** `supabase/tests/fuel_maintenance_delta_sync_history.sql` ينشئ 201 أمرًا في fixture مؤقت، ويحذف أحدث أمر، ثم يتحقق من بقاء العدد 200 وظهور البديل السابق في المرتبة 201، ومن وجود tombstone للحذف وupsert للبديل في دفتر Delta.
- **الحالة:** أُضيف الكود والاختبار إلى الفرع، لكن لم يُشغّل اختبار PostgreSQL أو CI بعد هذا التغيير. لا تُعتبر الفجوة مغلقة قبولًا حتى ينجح الاختبار وCI على رأس واحد. لم تُطبّق migration على أي بيئة ولم يُنشأ Preview.


## تحقق CI من عضوية قائمة أوامر الصيانة — 2026-10-29

- نجح GitHub Actions على رأس PR #359 `10a6aa0f504b27a9b0bd56c31069ad390b92f040`: PowerHub CI، PowerHub Security، Supabase Admin Guard، وReading Cycle PostgreSQL Integration.
- أظهر سجل PostgreSQL تنفيذ migration `20261029140000_powerhub_delta_fuel_events_maintenance_orders_parts.sql` ثم نجاح اختبار `supabase/tests/fuel_maintenance_delta_sync_history.sql` برسالة: Fuel-event and maintenance work-order/parts Delta snapshot, update, redaction and scope assertions passed.
- يتضمن ملف الاختبار تحققًا من عبور أمر الصيانة حدّ أحدث 200 بعد تغيير `reported_at`، ومن إعادة ملء القائمة بعد الحذف. أصبح ذلك تحقق CI ناجحًا على الرأس المذكور، وليس مجرد اختبار مضاف.
- **ما بقي خارج هذا الإثبات:** اختبارات متصفح فعلية لإعادة تحميل الصفحة/إعادة فتح المتصفح/العمل دون اتصال ثم Delta عند العودة، والتحقق التشغيلي من التقارير المفلترة في واجهة المستخدم. لا يُعد نجاح PostgreSQL بديلًا عن هذه الاختبارات.
- PR ما زال Draft وغير مدمج؛ لم تُطبّق migration على الإنتاج ولم يُنشأ Preview في هذه الجولة.


## الحفاظ على آخر عرض متاح عند فشل التحديث — 2026-10-29

- عولج سلوك واجهة تقريري الوقود والصيانة: إذا فشل الطلب الحي مع وجود لقطة مطابقة لنطاق المستخدم/الفرع/الفلاتر، تبقى اللقطة معروضة بدل استبدالها بحالة خطأ فارغة. يظهر تنبيه يوضح تاريخ اللقطة وأنها تجميع محفوظ وليست إعادة احتساب حيّة.
- إذا بقيت نتيجة ناجحة في جلسة TanStack Query الحالية ثم فشل التحديث، تبقى النتيجة الظاهرة مع تنبيه يفيد بتعذر التحديث؛ لا يُعرض الفشل على أنه نجاح حيّ.
- عولجت كذلك قوائم أوامر الصيانة والخطط الوقائية وقطع الأمر، وسجلا التعبئات والقراءات: وجود بيانات سابقة يسمح باستمرار عرضها مع تنبيه؛ أما إذا لم توجد بيانات فلا تُخفى حالة الخطأ ولا تُعرض رسالة «لا توجد بيانات» على أنها دليل على خلو السجل.
- **حدود واضحة:** القوائم ذات الفلاتر غير المدعومة لا تصبح مخزنة تلقائيًا بسبب هذا التعديل. الاستعادة بعد إعادة فتح المتصفح تظل محكومة بسياسة الكاش/Delta الحالية؛ التنبيه داخل الجلسة ليس بديلًا عن ذلك.
- أضيفت اختبارات عقود واجهة في `server/inventory-workspace.ui.test.ts` و`server/maintenance-phase-c.test.ts` لتثبيت هذه الحالات. قبول التغيير مشروط بنتيجة CI على الرأس النهائي نفسه واختبار متصفح فعلي لاحقًا.


## امتداد عضوية Delta وحماية اللقطات بعد رفض الصلاحية — 2026-10-29

- **تعبئات الوقود (أحدث 500):** أضيفت `powerhub_refresh_fuel_event_delta_scope`، ويعيد trigger بث أحدث 500 تعبئة عندما يخرج سجل بالحذف أو يتغير `occurred_at`، وكذلك يعيد ملء النطاق القديم والجديد عند انتقال السجل بين الفروع/المستأجرين. الغرض هو إرسال upsert للسجل الذي عبر من المرتبة 501 إلى القائمة، لا الاكتفاء بعلامة حذف.
- **اختبار تعبئات الوقود:** يهيئ `supabase/tests/fuel_maintenance_delta_sync_history.sql` 501 تعبئة اختبارية داخل PostgreSQL المؤقت، ثم يتحقق من تغيير الترتيب والحذف وثبات حجم اللقطة عند 500 ومن وجود upsert للبديل في دفتر Delta. الاختبار نفسه يغطي عضوية أوامر الصيانة ذات حد 200.
- **فلاتر الوقود:** وفّرت الواجهة استعلامًا Delta-backed غير مفلتر لآخر 100 قراءة، كبديل واضح عند فشل الاستعلام المفلتر حسب المولد. تُظهر الواجهة بوضوح أن البديل لا يطبق فلتر المولد أو التاريخ، ولا تدّعي أنه نتيجة كاملة للفلاتر الحالية.
- **رفض الصلاحية مقابل انقطاع الشبكة:** أضيف `isExplicitAuthorizationDenial` لاكتشاف `UNAUTHORIZED/FORBIDDEN` وHTTP `401/403` حتى عند تغليف الخطأ. أخطاء النقل العابرة تسمح بعرض آخر بيانات ناجحة من النطاق نفسه مع تحذير؛ أما رفض الخادم الصريح فيحجب اللقطة/بيانات الاستعلام المحلية، ويمنع استخدام نتيجة أوسع كبديل للطلب المرفوض.
- **إغلاق العمليات التابعة بأمان:** لا تُستخدم قائمة أوامر صيانة مرفوضة لاختيار أمر قطع تلقائيًا، ولا تُنفّذ قراءة قطع تابعة عند رفض الوصول إلى أمر الأب. كما يمنع إرسال عمليات التعبئة/قراءة الوقود باستخدام خيارات محلية قديمة بعد رفض صريح، ويمنع إغلاق أمر وقائي حين يتعذر التحقق من الخطة المرتبطة ومتطلبات ساعات التشغيل.
- **حدود القبول المستمرة:** نجاح SQL وCI لا يغني عن اختبار المتصفح الحقيقي لإعادة التحميل/إعادة الفتح/العمل دون اتصال ثم استعادة Delta، ولا يثبت أن التقارير التجميعية أعيد احتسابها محليًا؛ تلك اللقطات ما زالت منفصلة عن Delta.

- **تطابق ترتيب أوامر الصيانة بين الخادم وIndexedDB (2026-10-29):** أصبح فرز إسقاط Delta في المتصفح يستخدم نفس قاعدة ترتيب عضوية أحدث 200 أمر في الخادم: `reported_at DESC` مع الرجوع إلى `created_at DESC` عند غياب `reported_at`، ثم `id DESC` لكسر التعادل. أضيف اختبار وحدة صريح للتأكد من أن أمرًا بلا `reported_at` لا يزيح ترتيب اللقطة عن الترتيب الخادمي.


## تدقيق الموارد البشرية وتوثيق الدفع بعد CI — 2026-10-29

- **الموارد البشرية:** أضيف حظر صريح لـ`hr` في `BLOCKED_PROCEDURES`، بجانب `payroll` و`attendance`. لا يضيف ذلك مسار Delta أو مخزنًا جديدًا؛ بل يثبت قرار إبقاء السجل الشخصي والرواتب والحضور والسلف خادميًا. اختبارات `offline-query-cache.test.ts` تغطي استعلامات دليل الموظفين والحضور وكشوف الرواتب وتفاصيلها وتثبت بقائها خارج الكاش.
- **مراجعة توثيق الدفع:** لقطات المراجعة المحلية أصبحت مقسمة حسب هوية المستخدم والفرع وتوقيع مرشحات الاستعلام، مع TTL قدره 24 ساعة. رُفعت نسخة IndexedDB إلى v3 وإزالة المخزن السابق عند الترقية لأن صفوفه لم تحمل هوية مستخدم يمكن الوثوق بها.
- **إزالة اللقطات القديمة ضمن النطاق نفسه:** عند نجاح طلب الخادم تُستبدل مجموعة اللقطات للمرشح نفسه، بما في ذلك الاستجابة الفارغة؛ فلا يبقى طلب قديم ظاهرًا كأنه ما زال قيد التحقق بعد اعتماده أو رفضه.
- **دورة القراءة الحالية:** لا تُخزن لقطة `current_cycle` ولا تعرض دون اتصال لأن حدّي الدورة يُحسبان من الخادم، ولا يمكن التحقق محليًا من بقاء اللقطة ضمن الدورة نفسها.
- **حدود الحساب المالي:** لقطات المراجعة ليست حالة مالية رسمية؛ أي اعتماد يسجل دون اتصال يبقى عملية Outbox تنتظر العودة إلى الشبكة والتحقق من الصلاحية وحالة الطلب على الخادم. لا ينشئ العميل دفعة أو حركة حسابية محلية.
- **بوابة القبول:** تُطلب اختبارات CI على الرأس النهائي لهذه التعديلات، واختبار متصفح لتبديل الحساب/الفرع وإعادة فتح المراجعة دون اتصال. لم يُدمج PR ولم تُطبق migrations على الإنتاج أو staging.


## HR Phase 1 — verified contract gaps (2026-10-29)

- Employee directory ordering must match the existing server query: `created_at DESC, id DESC`; using `updated_at` for local membership is incorrect.
- Attendance membership must match the current server limit of 1000 rows ordered by `work_date DESC` and then `id DESC`. The local IndexedDB bound is aligned to 1000; this alone does not implement HR Delta.
- HR must remain excluded from generic cache until an exact, narrow read allowlist and safe projections are wired end-to-end. Never persist the raw employee response: it contains identity number, phone, wage and notes. Attendance results also join employee details and need the same minimization.
- Acceptance still requires PostgreSQL entity constraints and private Snapshot/Pull functions; transactional triggers/tombstones and bounded-list refill; explicit HR read authorization; runtime and query-cache bridge wiring; reload/offline UI verification; and SQL/client tests for deletion, replacement rows, tenant/site isolation, company-wide `site_id IS NULL`, cursor reset and sensitive-field redaction.
- No migration was applied to Supabase and no preview was deployed. HR phase 1 remains incomplete until all gates pass on one SHA.


## HR Phase 1 implementation update — 2026-10-29

This update supersedes the earlier “not wired end-to-end” status above for the current work branch. It records implementation scope, **not acceptance or deployment**.

- **Local-first operations use the existing shared Outbox and IndexedDB transaction model:** employee_create, employee_update, attendance_upsert, payroll_draft, employee_advance_issue, and employee_advance_repayment. Each operation keeps a stable UUID operation key and matching sync metadata; dependent operations are blocked until their parent operation is confirmed.
- **Dependencies and replay recovery:** temporary employee IDs are resolved to server IDs only after a successful create replay; local advance IDs are resolved only after the server confirms disbursement. Unattempted edits for the same employee or employee/date can coalesce; operations already attempted are not silently rewritten. Duplicate pending payroll-period drafts are blocked locally.
- **Server authority and idempotency:** employee/attendance/payroll-draft replay is routed through a protected server procedure which rechecks the caller’s role and site access, validates the payload and invokes a service-role-only PostgreSQL function. The database stores the operation key, scope, caller, operation type, payload hash and result in the same transaction as the mutation. Reusing a key with different input is rejected. Employee and attendance edits require an expected version; conflicts are not auto-merged.
- **Sensitive read projections:** the employee-directory Delta row contains only the bounded fields needed for offline directory display plus a version; it excludes identity number, phone, wage, linked-user ID and notes. Attendance rows exclude notes and creator IDs and minimize the joined employee. Snapshot bounds are 500 directory rows and 1,000 attendance rows; cursor retention and reset_required remain explicit. The HR cache allowlist is exact by procedure and site input; advances, payroll summaries and account-selection options use bounded, minimized display projections rather than the raw payroll/ledger responses.
- **UI behavior while offline:** employee creation and a limited set of employee fields can be queued; attendance can be recorded as a local draft; payroll creation is a **request for a draft**, not a calculated or approved payroll run; advances and repayments are pending requests. The UI labels these pending states. Approval, cancellation, disbursement and account receipt remain online-only and must be accepted by the server. A queued advance/repayment must not be interpreted as a completed account movement.
- **Manual review and retention:** version conflicts remain reviewable and are not replayed automatically. Cache sanitization removes personal/contact/wage/note and transaction-reference details where those are not required; the minimized branch account-options snapshot is not a balance or transaction ledger.

### Acceptance gates still open

- Run PowerHub CI, PostgreSQL Integration, Supabase Admin Guard and Security on one final SHA after these latest changes; no earlier green commit substitutes for this gate.
- Verify the complete flow in a staging browser: go offline after loading the directory, account options and attendance; create/update employees; create attendance; queue payroll draft and advance/repayment; reload; reconnect; verify dependencies, idempotent retry, rejected/conflicting operations, refreshed Delta rows and account balances.
- Confirm the UI does not present local pending requests as approved or financially posted. Validate account/site permissions with accounts linked to another branch and with inactive/missing accounts.
- No staging or production migration was applied and no Preview was deployed during this update. Do not merge or claim production readiness until the same-SHA gates and browser acceptance pass.
