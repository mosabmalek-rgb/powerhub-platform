# P6 — Scale & Operations

## الهدف

تحويل PowerHub من منصة جاهزة للإطلاق التجاري إلى منصة قابلة للتشغيل المستمر، المراقبة، التوسع، والاستعادة الآمنة.

## نطاق المرحلة

### 1. Health & readiness
- `GET /api/health` هو فحص liveness ولا يعتمد على بيانات العميل.
- `GET /api/ready` هو فحص readiness ويتحقق من توفر إعدادات Supabase الأساسية.
- كلا المسارين يعطّلان التخزين المؤقت حتى لا تُستخدم نتيجة قديمة في المراقبة.

### 2. Operational smoke tests

يجب أن يكون فحص الإنتاج قابلًا للتكرار بدون تدخل يدوي:

```bash
pnpm test:launch
pnpm test:ops
```

فحص `test:launch` يتحقق من واجهة الإنتاج العامة والأصول الرئيسية، بينما `test:ops` يتحقق من liveness/readiness الخاصة بالخدمة.

### 3. SLO baseline

الأهداف التشغيلية المبدئية:

| المؤشر | الهدف |
|---|---|
| Availability | ≥ 99.5% شهريًا |
| HTTP 5xx | < 1% من الطلبات |
| Health latency | p95 < 500ms |
| Readiness failures | 0 حالات غير مبررة |
| Critical financial incidents | 0 |
| Cross-tenant authorization incidents | 0 |

هذه أهداف تشغيلية وليست ضمانات؛ يجب تعديلها بعد توفر بيانات إنتاج فعلية لمدة كافية.

### 4. Capacity & scaling triggers

عند نمو الاستخدام، تتم مراجعة هذه المؤشرات قبل إضافة بنية تحتية جديدة:

- عدد الطلبات ومعدلها حسب المسار.
- p95/p99 للطلبات البطيئة.
- Runtime errors و5xx.
- استهلاك قاعدة البيانات والـquery latency.
- حجم بيانات القراءات والفواتير والمدفوعات.
- Cache hit/miss وسلوك React Query.
- زمن عمليات الاستيراد الثقيلة لـExcel/PDF.

لا تتم إضافة فهارس أو caching عشوائيًا؛ كل تحسين مبني على مسار مثبت بقياسات فعلية.

### 5. Reliability operating procedure

عند وجود Incident:

1. تحديد النطاق: المصادقة، البيانات، الشؤون المالية، المزامنة، أو الأداء.
2. وقف أي release جديد.
3. فحص Vercel runtime errors و5xx.
4. فحص آخر نشر ناجح.
5. حفظ timestamps والـrequest/incident context.
6. تنفيذ rollback للتطبيق عند الحاجة.
7. بالنسبة لمشاكل قاعدة البيانات، يُفضّل corrective migration للأمام بدل عكس migration عشوائيًا.
8. إعادة smoke + integrity checks.
9. توثيق السبب والإجراء التصحيحي.

### 6. Backup & restore

الـbackup/restore drill في Supabase يبقى بوابة موثوقية قبل التوسع الكبير. لا يتم إنشاء Supabase branch اختباري تلقائيًا لأن إنشاء branch قد يترتب عليه تكلفة؛ يجب أن تكون التجربة مصرحًا بها ومعلومة التكلفة قبل تنفيذها.

### 7. Security operations

يجب أن تبقى هذه العناصر صفرية أو خالية من الحوادث الحرجة:

- cross-tenant access
- cross-site access
- unauthorized platform-admin access
- duplicate financial mutations
- closed-period mutation
- public portal enumeration

توجد حاليًا إشعارات Supabase معلوماتية حول بعض foreign keys غير المفهرسة وبعض الفهارس غير المستخدمة، بالإضافة إلى تحذير حماية كلمات المرور المسرّبة. هذه عناصر متابعة تشغيلية ويجب معالجتها حسب الأولوية والقياس.

### 8. Release policy

لا يدخل release إلى `main` والإنتاج إذا فشل أحد الآتي:

- TypeScript
- full test suite
- production build
- security workflow
- launch smoke
- operational health/readiness smoke

ويجب الاحتفاظ بآخر production deployment موثوق كمرشح rollback.
