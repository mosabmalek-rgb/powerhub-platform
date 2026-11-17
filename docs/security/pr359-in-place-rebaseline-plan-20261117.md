# PowerHub — خطة إعادة تأسيس قاعدة البيانات داخل مشاريع Supabase الحالية
**مسار العمل:** PR #359، فرع \`feat/auth-local-first-single-pr\`  
**تاريخ قرار التخطيط:** 2026-11-17  
**الخيار:** In-place application database re-baseline؛ الاحتفاظ بمشروعَي Staging وProduction (Project Ref / API URL) دون إعادة إنشاء المشروعين  
**الحالة:** DESIGN PLAN / NO-GO FOR DESTRUCTIVE EXECUTION  
**الأثر حتى الآن:** توثيق فقط؛ لا DROP، لا TRUNCATE، لا تغيير أدوار أو سجل ترحيلات أو مستخدمي Auth، لا نشر Production، لا دمج

## 0. القرار وحدوده

المنصة **غير مطلقة**، وكل البيانات في Staging وProduction **اختبارية وتجريبية**؛ يمكن الاستغناء عن بيانات التطبيق التجريبية بعد نسخها وإثبات الاسترداد. لكن لا يُستنتج من ذلك السماح بتنفيذ حذفٍ فوريّ أو مسح قواعد Supabase المُدارة.

**الهدف:** بناء حالة تطبيق PowerHub المستهدفة من مصدر واحد مُراجع وقابل لإعادة الإنشاء، ثم تطبيقها على نفس مشروعي Supabase الحاليين بالترتيب: Docker محلي نظيف ← Staging الحالي ← Production الحالي، مع إبقاء الروابط الخارجية للمشاريع وعدم استبدال مفاتيحها تلقائيًا.

**ليس ضمن نطاق السماح الحالي:** إعادة إنشاء/حذف مشروع Supabase، إسقاط مخططات Supabase المُدارة، استدعاء \`supabase db reset --linked\` أو \`--db-url\`، تشغيل 700 ملف تاريخي دفعةً واحدة، تعديل \`supabase_migrations.schema_migrations\` يدويًا لإظهار نجاح وهمي، تشغيل رسائل SMS حقيقية، تغيير بيانات مالية فعلية، الدمج أو النشر.

**قد نحتاج إلى مراجعة القرار:** الاحتفاظ بالمشروع والـURLs لا يعني أن جميع الحسابات أو ملفات Storage أو cron jobs أو جلسات Auth ستظل سليمة بعد إعادة التأسيس. الفشل في إثبات نسخة احتياطية واسترداد قابل للتنفيذ أو إيجاد انتقال موثّق لسجل الترحيلات = NO-GO. عندئذ نقيّم إنشاء مشروع جديد بدل فرض إعادة تأسيس غير آمنة داخل المشروع الحالي.

## 1. خط أساس حقيقي تم التحقق منه (قراءة فقط)

المستودع \`mosabmalek-rgb/powerhub-platform\`، PR #359 مفتوح Draft عند SHA المرجعي قبل إنشاء هذه الوثيقة:
\`f351e6eb027df363a1b46717032120fc67b05aac\`، أساس \`main\` عند الفحص \`8602b155c410749ef04b79cb072cc59d5fed76bf\`.

| المؤشر | Production \`vvcdiqcyhaloxesvpppc\` | Staging \`iyuryuhaylhisjfcrwkz\` |
| --- | ---: | ---: |
| جداول \`public\` | 145 | 173 |
| جداول \`private\` | 7 | 10 |
| دوال \`public\` | 389 | 579 |
| دوال \`private\` | 46 | 57 |
| دوال \`powerhub_private\` | 5 | 5 |
| حسابات \`auth.users\` | 4 | 7 |
| كائنات \`storage.objects\` | 5 | 0 |
| صفوف سجل الترحيلات | 486 | 553 |

ثلاثة قيود FK من \`public\` إلى \`auth.users\`: \`powerhub_user_device_locks_user_id_fkey\` و\`staff_password_reset_intents_auth_user_id_fkey\` و\`users_auth_user_id_fkey\`. هذه تعني وجوب تحديد سياسة حسابات Auth وإعادة تأسيس جداول التطبيق معًا، وعدم افتراض استقلال \`public\`.

في \`supabase/migrations\` يوجد **700 ملف SQL** حاليًا؛ سُجل تاريخيًا **28 مجموعة اختلاف** و**85 سجلًا بلا SQL محتفظ به** (82 في Staging + 3 في Production). هذه **أدلة تاريخية للبيئتين القديمتين** وليست ترحيلات معتمدة لتأسيس قاعدة جديدة. يوجد مسار \`drizzle/\` تاريخي أيضًا؛ يجب حل ازدواج مصدر تعريف المخطط قبل اعتماد Baseline.

المخاطر المادية المثبتة: اختلاف RPC المالي \`powerhub_dashboard_financial_overview\`، اختلاف سياسات Chat/RLS وRealtime/Storage، غياب جدول ائتمان المشترك وثلاثة أعمدة مدفوعات وبعض الترحيلات المالية في Production، والحاجة لمراجعة SECURITY DEFINER والصلاحيات.

## 2. استراتيجية Baseline الهندسية

1. أنشئ مصدر تأسيس جديدًا للمخطط المطلوب **من العقود والكود والكتالوج بعد المراجعة**، لا من نسخة Staging الخام ولا من مخطط Production القديم ولا بمجرد جمع كل ملفات الترحيل. اجمع جداول التطبيق والفهارس والقيود والتريجرات والدوال وACL/RLS والسياسات وميزات الدردشة والتقارير والحسابات والمزامنة.
2. ثبّت نطاق ملكية الكائنات في Manifest مُفصّل: كل Schema/Object/Owner/Dependencies/DDL SHA/Expected Grants، وتمييز \`APP_OWNED\` عن \`SUPABASE_MANAGED\` و\`SHARED_DEPENDENCY\` و\`UNKNOWN\`. أي كائن \`UNKNOWN\` يمنع التنفيذ.
3. ضع Baseline نظيفًا في مسار منضبط جديد للحقبة الجديدة، واترك ملفات الترحيلات التاريخية قابلة للتتبع مؤرشفة في Git. **لا تشغّل 700 تاريخيًا على قاعدة جديدة** ولا تعتمد \`db push\` على المشروع القديم قبل إثبات كيفية تجاوز أو مصالحة سجل \`supabase_migrations\` دون تزوير التاريخ.
4. صمّم \`Migration Epoch v2\`: (أ) أرشفة/تجميد سجل الحقبة القديمة مع بصماته، (ب) تعريف طريقة الإطلاق المسموحة للـBaseline ثم ترحيلات v2 الجديدة من مُنفّذ محمي يقرأ النسخة/الـSHA والحالة المتوقعة، (ج) اختبار قابلية الاستخدام مستقبلًا مع CLI/CI. **أي إعادة تهيئة لسجل Supabase تتطلب تصميمًا ومراجعة وتجربة مستقلة ولا تنفَّذ بافتراض أن سجل الحقبة القديمة فارغ**.
5. اختبارات SQL هنا يجب أن تتعامل مع Supabase المحلي الكامل متوافق الإصدارات (Auth/Storage/Realtime/Extensions) لا PostgreSQL خام فقط. لا تضع أوامر Docker-only compatibility داخل ترحيلات الإنتاج.

## 3. مراحل التنفيذ وبوابات المنع

| المرحلة | العمل | إثبات الانتقال |
| --- | --- | --- |
| R0 — Freeze & Inventory | تثبيت SHA ونطاق إعادة التأسيس؛ تسجيل الخدمات والـTriggers والـFK والـCron وStorage/Auth وبيئات Vercel وAndroid وGitHub وSMS؛ إثبات عدم وجود مستخدمين حقيقيين | Inventory موقّع، لا كائنات غير مصنفة |
| R1 — Backup & Recovery Proof | نسخ SQL منطقي موثوق، مخططات التطبيق وبياناته، History وأدوار وإعدادات/ملحقات؛ تصدير ملفات Storage عبر API وAuth configuration؛ تسجيل SHA-256 ووقت الالتقاط؛ **تجربة استعادة ناجحة** إلى نسخة معزولة | \`BACKUP_RESTORE_PASS\` + مطابقة أعداد/بصمات، بلا أسرار داخل Git أو CI artifacts |
| R2 — Canonical Baseline | إعداد Baseline وملحقات هوية/صلاحيات وRLS وRPC والـFK وSeeder تجريبي؛ اختيار طريقة \`Migration Epoch v2\` آمنة عبر تجربة عملية | \`BASELINE_REVIEW_PASS\`، معرفات SQL/SHA، قرار ledger مُوثق |
| R3 — Clean Docker & Integration | إنشاء قاعدة نظيفة مرتين من نفس Baseline، اختبار repeatability، rollback/forced fault، مقارنة schema/ACL/RPC fingerprints، واختبار SDK/HTTP على Supabase محلي | \`CLEAN_BOOTSTRAP_PASS\` + \`CLEAN_REBUILD_DETERMINISTIC_PASS\` |
| R4 — Staging In-Place | وقف المهام والكتابة، جرد Final، backup قابل للاسترداد، مراجعة أمر تفكيك كائنات \`APP_OWNED\` حصريًا، إعادة تأسيس معزولة؛ الاحتفاظ بالمخططات المُدارة؛ إعادة بناء حسابات تجريبية | \`STAGING_INPLACE_PASS\` + اختبارات واجهة/خادم/Android |
| R5 — Functional/Security/Finance | مصفوفة القبول الشاملة أدناه وإصلاح الفجوات بدون خفض حدود الأمان | \`ACCEPTANCE_PASS\` + 5 CI gates وDocker وSecurity dependency audit |
| R6 — Production In-Place | موافقة صريحة منفصلة على مجموعة أوامر محددة وSHA؛ تجميد حركة الكتابة، تأكيد النسخ، التنفيذ التدريجي المراقب، اختبارات الإنتاج التجريبية | \`PRODUCTION_INPLACE_PASS\` + Rollback evidence + تأكيد المستخدم |
| R7 — Closeout | أرشفة الترحيلات القديمة وأدلتها، تحديث README/runbooks والـCI، اعتماد epoch الجديدة، تصفية بيانات الاختبار فقط بعد التحقق | \`REBASELINE_ACCEPTED\` ثم قرار دمج ونشر **منفصل** |

**الحدود الصلبة:** لا انتقال إلى R4 بدون R1+R2+R3. لا انتقال إلى R6 بدون R4+R5 وموافقة تنفيذ حديثة مستقلة. كل إصدار مرتبط بـGit SHA وSQL SHA؛ نجاح فحص كود لا يساوي نجاح ترحيل.

## 4. قائمة الجرد الحساسة — لا يُسمح بالمسح العام

المخططات المحجوزة/المُدارة (منها \`auth\` و\`storage\` و\`realtime\` و\`extensions\` و\`vault\` و\`supabase_migrations\` و\`graphql\` و\`cron\` و\`net\`) **غير مؤهلة لـDROP أو CASCADE جماعي**، وكذلك أدوار Supabase وقواعد ACL المرتبطة بها. \`public\` و\`private\` قد تضم كائنات مشتركة، فيُسمح فقط لقائمة allowlist مثبتة الملكية. يجب فحص \`pg_depend\` و\`pg_constraint\` و\`pg_trigger\` و\`pg_event_trigger\` وعلاقات الملكية والتعريف قبل تخطيط ترتيب الحذف.

- **Auth:** سياسة قرار محددة لكل حساب تجريبي: إبقاؤه مع تصحيح ملف \`public.users\` وعضوياته، أو إزالته **بواجهات Admin المناسبة** بعد موافقة وتصوير حالته، ثم إنشاء مستخدمين جدد مع تغيير كلمات المرور والتأكد من قفل الجهاز الواحد. لا حذف مباشر من \`auth.users\` باعتباره جدول تطبيق.
- **Storage:** احتفظ بسجلات وأجسام الملفات بشكل متوافق، أو امسح الملفات التجريبية عبر Storage API بعد إثبات نسخها؛ لا يكفي \`DELETE FROM storage.objects\` لإزالة الأجسام.
- **Environment:** احتفظ بمراجع المشاريع وAPI URLs والمفاتيح الحالية عند بقائهما، لكن راجع كل متغيرات Vercel وGitHub Secrets وSupabase Edge Functions وAndroid وSMS/webhooks بعد التأسيس، وأعد تدوير أي سر كُشف. عدم تغيير Project Ref لا يعني ثبات جلسات المستخدمين أو إصدار التوكنات.
- **Offline:** لا تمسح IndexedDB/Room أو Outbox بعمليات عامة. أجرِ سياسات \`schema_epoch\` و\`cache_version\` و\`sync_cursor\` وإبطال بيانات الكاش القديمة واسترداد عمليات Outbox غير المرسلة بدون فقد أو تكرار؛ اعمل على حسابات اختبارية فقط.

## 5. مصفوفة القبول (لا اختصار)

**Finance:** إنشاء وتعديل المشترك؛ افتتاحية القراءة؛ دورات WEEKLY/EVERY_10_DAYS/EVERY_15_DAYS/MONTHLY وحالات فبراير؛ إصدار فاتورة/تكرار/تصحيح؛ التحصيل النقدي/التحويل/اعتماد توثيق الدفع وصورة الإيصال؛ تسويات أعشار المبالغ؛ أصول القيود المزدوجة وGL/Subledger؛ شراء/استلام الوقود والمخزون (اختيار المخزن التلقائي عند واحد فقط)؛ المرتجعات واسترداد النقد الموردين؛ السلف والتسويات؛ صرف الرواتب؛ إقفال/عكس الفترة؛ حالات الفشل الجزئي والتزامن/idempotency؛ حفظ أرصدة الصندوق والدائنين وأثر التزامن.

**Auth/RBAC:** حساب إداري وصاحب مولد ومحاسب وفني؛ صلاحية فرع محدد أو كل الفروع؛ تخصيص الصلاحيات بعد اختيار الدور، سحبها أثناء الجلسة؛ **لا تظهر عناصر واجهة ولا تعمل RPC/API** دون صلاحية؛ عزل ثنائي المستأجر والفرع؛ RLS وSECURITY DEFINER/EXECUTE؛ رفض الطلب المجهول والتلاعب بالمعرّفات؛ جلسة الجهاز الواحد وإصلاح انحراف ساعة الجهاز.

**Operational:** تحكم individual feature entitlements \`support_chat\` و\`powerhub_ai_assistant\`؛ Unified Messaging/10/15/weekly/monthly/reminders مع Preview فقط (لا SMS حقيقي)؛ قراءة ميدانية وOCR وإرسال 0–2 منازل عشرية؛ Delta Sync حقيقي ولوحة التحكم وباقي التبويبات؛ Offline bootstrap/cursors/idempotency و48 ساعة/جلسة؛ استعادة Outbox؛ تقارير وإحصاءات أداء وتوثيق دفع؛ مخزون ووقود وصيانة وتصدير PDF/Excel.

**Acceptance performance:** اختبارات B5 مع عتبة \`p95 <= 3000 ms\` حيث ينطبق العقد المعتمد، لا ترفع السقف لتخفي تجاوزًا. مسارات 401/403/400 تتوافق مع عقود القبول. يجب تنفيذ الأمن والتحصيل عبر HTTP متى كانت هذه مسارات الإنتاج، وليس الاكتفاء بفحوص SQL/الوحدة.

**CI:** PowerHub CI + Reading Cycle PostgreSQL Integration + PowerHub Security (وتدقيق pnpm الكامل) + Supabase Admin Guard + B5 + Docker Clean Baseline. ثغرة \`picomatch@4.0.7\` / \`GHSA-fc5q-39xc-vjpf\` سبب فشل \`PowerHub Security\` عند آخر فحص، لا يُسمح بتهوين severity أو استثناء الثغرة دون معالجة موثقة ومراجَعة.

## 6. خطة التعامل مع الفشل والاسترداد

- **قبل التنفيذ:** يجب أن تتوفر نسخة SQL خارج المستودع مع SHA، ونسخ Storage منفصلة، ودليل استعادة فعلي إلى بيئة Docker مطابقة قدر الإمكان، وتقرير اعتماد، وقائمة أوامر Allowlist قابلة للعرض والمراجعة. نجاح \`supabase db dump\` وحده ليس \`BACKUP_RESTORE_PASS\`.
- **إيقاف تلقائي:** عند أول خطأ، اختلاف counts/constraints/fingerprints أو تكوين permissions غير متوقع، لا متابعة للحذف أو إعادة تنفيذ عمياء، ولا تزوير سجل الترحيلات.
- **Recovery:** إذا كانت العملية داخل معاملة فعليًا وخالية من آثار غير قابلة للتراجع، اختبر \`ROLLBACK\`. خلاف ذلك استعد **كائنات التطبيق فقط** من النسخة الموثقة وفق مخطط استعادة مختبر، مع مراجعة Auth/Storage غير الممسوسة. لا تُعلن استعادة Production قبل مطابقة العقد.
- **اتصالات الخدمة:** خذ لقطة إعدادات وتوقيت القرار، واحتفظ بنقطة تعطيل الكتابة؛ بعد الفشل لا تُفعّل Vercel/Android أو المهام الدورية قبل نجاح فحوص الاسترداد.
- **خطة احتياطية:** إن لم يمكن حل Epoch/Managed Schema دون مخاطر أو إن فشل restore proof، أوقف المسار داخل المشروع نفسه وارجع إلى خطة **مشروع Supabase جديد**، دون حذف القديم حتى قبول الجديد.

## 7. أول دفعة تنفيذية عند الاستئناف

**R0 فقط، دون أي SQL مدمّر:**
1. بناء \`in-place-rebaseline-inventory.json\` من استعلامات كتالوج قراءة فقط لـProduction وStaging: schemas, objects, dependencies, grants, policies, triggers, functions, cron, extensions، وحالات Auth/Storage، مع SHA وملاحظات مصدر دون أسرار.
2. حسم هل سيتم الاحتفاظ بحسابات Auth التجريبية أم إزالتها عبر Admin APIs، وهل نحتاج نقل صور Storage. يجب أن يكون هذا القرار منفصلًا عن تنظيف جداول التطبيق.
3. إعداد Compatibility Matrix للعقود المالية والتشغيلية والـRPC/RLS واستخراج مرشح Canonical Baseline من المصدر والكائنات الحالية بعد مراجعة التعارضات.
4. توثيق Migration Epoch v2 والمسار الجديد للـCI والـCLI؛ لا تلمس \`schema_migrations\` قبل اختبار الخطة محليًا.
5. إنشاء قائمة R1 backup/restore حقيقية، لا تتجاوزها بسبب مجانية Supabase أو كون البيانات اختبارية.

**Decision now:** Strategy selected for design; \`R0=NOT_ACCEPTED\`, \`R1..R7=NOT_STARTED\`, \`PRODUCTION_INPLACE_GO=false\`, \`PR359_MERGE_GO=false\`.

## 8. مراجع رسمية

- Supabase CLI local workflow: https://supabase.com/docs/guides/local-development/cli-workflows
- CLI reset (تحذير --linked/--db-url يحذف user-created entities): https://supabase.com/docs/reference/cli/supabase-db-reset
- Restore and limitations: https://supabase.com/docs/guides/self-hosting/restore-from-platform
- Permanent project deletion: https://supabase.com/docs/guides/platform/delete-project
