# P7.2 — Unified Sync Engine Design

## الهدف
توحيد طوابير العمل دون اتصال الموجودة حاليًا في PowerHub Web داخل محرك مزامنة واحد، مع إبقاء الخادم مصدر الحقيقة النهائي.

## مبادئ التصميم

1. كل عملية Offline تحصل على `clientOperationId` فريدًا وثابتًا عبر كل إعادة محاولة.
2. لكل عملية `tenantId` و`siteId` و`userId` مرتبطة بسياق المصادقة الذي أنشأها.
3. العمليات تُنفذ بترتيب dependencies، ولا تُرسل عملية تعتمد على عملية فاشلة قبل معالجة نتيجتها.
4. إعادة الإرسال يجب أن تكون آمنة idempotently على الخادم.
5. التعارضات لا تُدمج تلقائيًا في البيانات الحساسة؛ تُحوّل إلى حالة `conflict` للمراجعة.
6. العمليات المالية النهائية تبقى server-authoritative؛ أي مسودة دفع Offline لا تجعل الرصيد أو الإيصال رسميًا قبل قبول الخادم.
7. retry/backoff لا يسمح بدورة لا نهائية ولا يكرر mutation ماليًا.

## نموذج العملية

```text
id
clientOperationId
userId
tenantId
siteId
kind
payload
dependsOn[]
createdAt
updatedAt
attempts
nextAttemptAt
status
lastError
appliedEntityId
```

## حالات العملية

```text
pending → syncing → applied
                 ↘ retryable → pending
                 ↘ conflict
                 ↘ failed
```

## ترتيب الاعتماديات

مثال للعمليات التشغيلية:

```text
subscriber_create
       ↓
reading_create
       ↓
reading_approve
       ↓
invoice_draft
```

ولا يُسمح بتحويل `payment_create` إلى عملية authoritative Offline؛ عند عودة الاتصال تُرسل إلى الخادم ضمن سياسة الدفع الحالية.

## حدود P7.2

هذه الوثيقة لا تنفذ بعد تغييرات قاعدة البيانات أو endpoint جديد. التنفيذ التالي يجب أن يضيف طبقة Sync Engine في العميل، مع اختبارات unit/integration، ثم endpoint/server contract موحد يعتمد على idempotency الحالية في العمليات الحساسة.

## معايير القبول

- لا توجد طوابير متعارضة لنفس النوع من العمليات.
- نفس `clientOperationId` لا ينتج عمليتين خادميتين.
- ترتيب الاعتماديات مضمون.
- التعارض قابل للمراجعة وإعادة المحاولة.
- retry/backoff محدود وقابل للرصد.
- لا تعتمد البيانات المالية النهائية على cache محلي.
