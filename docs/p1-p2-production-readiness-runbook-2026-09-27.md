# PowerHub P1/P2 Production Readiness Runbook

**النطاق:** تجهيز المستودع للتوسع دون دفع أو نشر تلقائي.

## P1 — قبل الـpilot الموسع

### Migration وSchema drift

1. اعتبر Git migration ledger مصدر الحقيقة.
2. خذ snapshot من `supabase_migrations.schema_migrations` في Production وstaging.
3. نفّذ schema diff قراءة فقط، ثم صنّف الفروق إلى:
   - موجود في Production وغير موجود في Git.
   - موجود في Git وغير مطبق.
   - اختلاف تعاقدي يحتاج repair migration.
4. لا تستخدم `db reset` على Production.
5. طبّق migrations الجديدة على staging أولًا، ثم سجّل commit ونتيجة smoke tests.

### Restore/PITR drill

- الهدف المبدئي: **RTO ≤ 4 ساعات، RPO ≤ 15 دقيقة**.
- الاستعادة تكون إلى مشروع معزول، وليس Production.
- بعد الاستعادة نفّذ:
  - فحص عدد الجداول والـRPCs.
  - فحص `relrowsecurity` والسياسات.
  - قراءة عينة tenant/site isolation.
  - اختبار allocator idempotency.
  - اختبار queue lease recovery.
  - `/api/health` و`/api/ready`.
- وثّق وقت بداية الطلب، أول اتصال، اكتمال schema، اكتمال smoke tests، وأي فقد متوقع.

### Security operations

- Leaked Password Protection خارج التنفيذ الآلي: يفعّله مالك المشروع يدويًا.
- تدوير الأسرار يجب أن يتم عبر Supabase/Vercel settings وبخطة rollback.
- لا تُسجّل access tokens أو credential ciphertext في logs.
- أي webhook يحتاج signature + timestamp/event-id dedupe قبل اعتماده على نطاق واسع.

### Observability minimum

راقب يوميًا:

- API: rate, errors, duration.
- DB: latency, locks, connections, WAL, autovacuum.
- SMS: queue depth, oldest due, processing age, failed/needs-review.
- Financial: mutation success, replayed, conflict, duplicate effect.
- Cron: success, lag, overlap.
- Deployment SHA وmigration version.

## P2 — إثبات السعة على staging فقط

### Dataset synthetic

- 500 مولد أو أكثر.
- 2,500 مستخدم.
- 52 مليون فاتورة سنويًا كمرجع، مع عدم إنشاء البيانات دفعة واحدة في Production.
- بيانات skewed لمستأجر كبير، وليس توزيعًا متساويًا فقط.

### Workloads

1. ramp إلى 300 مستخدم متزامن.
2. إصدار 1,000 فاتورة/دقيقة لمدة 30–60 دقيقة.
3. burst قصير إلى 5,000 فاتورة/دقيقة.
4. مدفوعات متزامنة مع retries/timeouts.
5. SMS workers بدرجات 1/4/16/32 مع mock provider يعيد 429 وtimeout.
6. exports بحجم 10k/100k/1M صف عبر job غير متزامن.
7. offline queue بحجم 10k draft مع crash/resume.

### Acceptance gates

- لا يوجد cross-tenant leakage.
- duplicate financial effect = صفر.
- invoice mutation p95 ≤ 1s.
- paginated history p95 ≤ 500ms وpayload ≤ 1MB.
- queue oldest due أقل من 5 دقائق بعد الاستقرار.
- processing rows العالقة = صفر بعد lease recovery.
- أي نتيجة غير مؤكدة لا تعاد تلقائيًا دون reconciliation.
- كل نتيجة مرتبطة بـ commit SHA وschema version.

## ما لا يجوز اعتباره مكتملًا محليًا

- Restore/PITR حتى ينفذ drill فعلي في بيئة معزولة.
- RLS behavior حتى تنجح مصفوفة anon/authenticated/service_role وtenant/site على staging.
- Throughput حتى ينفذ load test على staging ببيانات اصطناعية.
- Production readiness حتى تمر بوابات CI/Security/Supabase Admin Guard وتتم مراجعة migration drift.
