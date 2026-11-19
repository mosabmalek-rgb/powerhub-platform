# PR #359 — R3 Local Stack compatibility correction

## القرار

كان هدف `real-restored-finance` السابق يبدأ من صورة `supabase/postgres:17.6.1.155` منفردة. هذه الصورة لا تمثل Supabase Local Stack الكامل، ولذلك ظهرت فروقات مبكرة في مخططات Auth/Storage/Realtime قبل استيراد أي مخطط أو بيانات التطبيق. لم يكن هذا فشلًا في بيانات PowerHub نفسها، بل كان عدم توافق في نوع بيئة الاستعادة.

تم تعديل مسار `full` ليستخدم Supabase Local Stack المثبت عبر `supabase/setup-cli` بالإصدار `3.2.0`، داخل شبكة Docker مخصصة، مع استخراج `DB_URL` من `supabase status -o env` والتحقق من أنه Loopback فقط. لا تُستخدم بيانات اعتماد Production داخل الحاويات الهدف، ولا تُرسل عمليات إلى Staging أو Production.

مسار `smoke` بقي منفصلًا ويستمر في اختبار Docker networkless والصلاحيات المحجوزة.

## بوابة التوافق

أضيف `check-managed-stack-compatibility.mjs` فوق المقارنات الحالية. البوابة لا تتجاوز التحقق، بل تقارن:

- الأعمدة والأسماء والأنواع المدارة.
- Ledger ترحيلات Auth/Storage/Realtime مع checksums.
- الملكية ونوع العلاقة وRealtime partition topology.
- أعمدة وقيود الفروقات التشغيلية المسموح بها فقط.

الفرق المسموح به صراحة وبشروط قابلة للاختبار هو:

1. `storage.iceberg_namespaces`.
2. `storage.iceberg_tables`.
3. Realtime daily partitions التي يكون مالكها `supabase_realtime_admin`، وأصلها `realtime.messages`، وحدودها يومًا واحدًا متصلًا.

أي جدول أو عمود إضافي آخر، أو أي نقص، أو اختلاف نوع، أو اختلاف Ledger، أو partition بمالك/حدود غير صحيحة يظل مانعًا ويؤدي إلى فشل البوابة. لا توجد متغيرات Skip أو Allowlist عامة.

تُجرى البوابة قبل تصدير أي بيانات أعمال، ثم قبل وبعد استيراد مخطط التطبيق، كما يُفصل `PGSSLMODE=require` الخاص بالمصدر قبل الاتصال بالـLocal Stack.

## الاختبارات المحلية

على رأس العمل الحالي:

- `bash -n scripts/pr359-shadow/run.sh` — PASS
- `node --check scripts/pr359-shadow/check-managed-stack-compatibility.mjs` — PASS
- اختبارات حواجز الكتالوج والترحيلات والطوبولوجيا وIceberg والجاهزية — PASS
- اختبارات حارس التوافق الجديد (قبول الفروقات الموثقة ورفض الفروقات العادية والنقص) — PASS
- إجمالي الاختبارات المنفذة في الجولة: 30 PASS، 0 FAIL

## حالة القبول

`R3_DOCKER_LOCAL_STACK_COMPATIBILITY_CODE_READY=true`

`R3_ACCEPTED=false`

لم يُنفذ Docker Full Restore داخل هذه البيئة لأن Docker غير متاح هنا. لذلك لا تُعلن نتائج `CANONICAL_BASELINE_BUILD_PASS` أو `ISOLATED_RESTORE_PASS` أو `REPEATABILITY_PASS` حتى تنجح Workflow `real-restored-finance` على نفس SHA في GitHub Actions. لا يوجد أي تغيير على Supabase المستضاف، ولا دمج لـPR #359، ولا نشر Production.
