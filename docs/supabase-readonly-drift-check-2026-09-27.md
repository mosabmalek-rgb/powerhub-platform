# Supabase read-only drift check — 2026-09-27

تم تنفيذ الجرد عبر Supabase MCP بقراءة فقط على المشروعين التاليين:

| البيئة | المشروع | الحالة | آخر migration ظاهرة |
|---|---|---|---|
| Production | `vvcdiqcyhaloxesvpppc` | ACTIVE_HEALTHY | `20260926101458` |
| staging-dr | `iyuryuhaylhisjfcrwkz` | ACTIVE_HEALTHY | `20260922093834` |

## النتيجة الأمنية

RLS مفعّل على الجداول التي ظهرت في كلا المشروعين. Production يحتوي عدة جداول داخلية بـ`policy_count = 0`، منها جداول allocator/device locks وبعض جداول feature controls والطلبات الداخلية. هذا لا يفتح وصولًا للمستخدمين العاديين لأن RLS مفعّل وعدم وجود policy يعني default deny للأدوار العامة، كما أن المسارات الخادمية تستخدم service role. لكنه يظل drift/توثيقًا ناقصًا، وتعالجه migration `20260927114000_powerhub_internal_rls_acl_hardening.sql` صراحةً بتثبيت `service-role-only` intent.

staging ليس نسخة أحدث من Production؛ يحتوي جداول chat وSMS مختلفة، بينما Production يحتوي جداول أحدث مثل `powerhub_invoice_sequences` و`powerhub_user_device_locks`. لذلك لا يجوز استخدام staging كـsuperset أو تطبيق reconciliation تلقائي.

## النتيجة التشغيلية

ملفات Git المحلية الجديدة مثل:

- `20260926190000_powerhub_bigint_invoice_allocator.sql`
- `20260927110000_powerhub_keyset_pagination_indexes.sql`
- `20260927112000_powerhub_sms_lease_recovery.sql`
- `20260927114000_powerhub_internal_rls_acl_hardening.sql`
- `20260927121000_powerhub_hot_path_indexes.sql`

ليست مثبتة في Production وفق آخر migration version المقروءة. لم يتم تطبيق أي واحدة منها خلال هذا الفحص، ولم تتغير بيانات أو إعدادات خارجية.

## القرار

- لا يوجد cutover تلقائي.
- لا يتم تطبيق migrations على Production قبل staging isolated rehearsal.
- يجب إنشاء reconciliation report بالـchecksums/definitions، لا مقارنة timestamps فقط.
- يجب تشغيل اختبارات invoice allocator وSMS lease وRLS matrix على staging بعد تجهيز schema compatible، ثم طلب نشر مستقل.
