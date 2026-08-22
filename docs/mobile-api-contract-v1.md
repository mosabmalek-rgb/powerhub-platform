# عقد تكامل تطبيق Android مع PowerHub — Mobile API v1

## الهدف

يستخدم تطبيق `app-power-` هذا العقد لإرسال القراءات الميدانية واستقبال المشتركين المسموح بهم. يبقى تطبيق الويب معتمداً على tRPC، بينما يوفر PowerHub طبقة REST مخصصة للموبايل تحت `/api/mobile/v1` حتى لا يعتمد التطبيق على تفاصيل tRPC الداخلية.

## قواعد عامة

| القاعدة | القرار |
|---|---|
| الإصدار | كل المسارات تبدأ بـ `/api/mobile/v1`. |
| النقل | HTTPS فقط في البيئات غير المحلية. |
| المصادقة | Bearer access token قصير العمر مع refresh token لا يُرسل في كل طلب بيانات. |
| الزمن | ترسل التواريخ بصيغة ISO-8601 UTC، مثل `2026-08-22T14:30:00.000Z`. |
| الأرقام | ترسل قراءة العداد كنص عشري لضمان عدم فقدان الدقة، مثل `1250.500`. |
| العزل | يحدد الخادم `tenantId` والفروع المسموحة من جلسة المستخدم، ولا يقبل التطبيق كمرجع ثقة. |
| التكرار | كل عملية قراءة تحمل `clientOperationId` UUID ثابتاً لإعادة المحاولة بأمان. |
| النتائج | المزامنة المجمعة تعيد حالة كل عنصر، وليس نجاحاً عاماً فقط. |

## المصادقة

```text
POST /api/mobile/v1/auth/login
POST /api/mobile/v1/auth/refresh
POST /api/mobile/v1/auth/logout
GET  /api/mobile/v1/auth/me
```

طلب الدخول:

```json
{
  "username": "field.user",
  "password": "••••••••"
}
```

استجابة الدخول:

```json
{
  "accessToken": "…",
  "refreshToken": "…",
  "expiresIn": 900,
  "user": {
    "id": 42,
    "name": "اسم المستخدم",
    "role": "collector",
    "tenantId": 7,
    "branches": [{ "id": 12, "name": "الفرع الرئيسي" }]
  }
}
```

يجب تخزين التوكنات في Android Keystore أو آلية آمنة مكافئة، وعدم وضعها في SharedPreferences العادية أو السجلات.

## المشتركين

```text
GET /api/mobile/v1/subscribers?branchId=12&cursor=…&limit=100
```

يعيد الخادم المشتركين المسموح للمستخدم بقراءتهم فقط، مع معرفات PowerHub الرقمية:

```json
{
  "items": [{
    "id": 456,
    "subscriberNo": "SUB-000456",
    "fullName": "اسم المشترك",
    "phone": "+970595000000",
    "branchId": 12,
    "meterId": 789,
    "lastReading": "1250.500",
    "lastReadingAt": "2026-08-01T08:00:00.000Z"
  }],
  "nextCursor": null
}
```

## رفع صورة العداد

```text
POST /api/mobile/v1/uploads/meter-photo
Content-Type: multipart/form-data
```

يعيد الخادم مرجعاً مؤقتاً أو دائماً للمرفق، ولا يُعتبر الرفع مكتملاً قبل حفظ الاستجابة محلياً وربطها بعملية القراءة.

```json
{
  "uploadId": "upl_…",
  "objectKey": "meter-readings/…",
  "url": "https://…"
}
```

## إرسال القراءة

```text
POST /api/mobile/v1/readings
```

```json
{
  "clientOperationId": "550e8400-e29b-41d4-a716-446655440000",
  "branchId": 12,
  "subscriberId": 456,
  "meterId": 789,
  "readingValue": "1250.500",
  "readingAt": "2026-08-22T14:30:00.000Z",
  "captureMethod": "photo",
  "isMeterReplacement": false,
  "fieldVerified": true,
  "latitude": 31.900000,
  "longitude": 35.200000,
  "photoUploadId": "upl_…",
  "notes": "قراءة ميدانية"
}
```

التحقق النهائي يتم في الخادم: ملكية المشترك والعداد والفرع، القراءة السابقة، عدم التكرار، حالة الفترة المقفلة، صلاحية المستخدم، وصحة `clientOperationId`. إذا أُعيد إرسال نفس المعرف، يعيد الخادم نفس النتيجة دون إنشاء قراءة ثانية.

## المزامنة المجمعة

```text
POST /api/mobile/v1/sync
```

يمكن استخدامها للقراءات المؤجلة والدفعات المسموح بها بعد اكتمال عقد الدفعات:

```json
{
  "items": [{
    "type": "reading",
    "clientOperationId": "550e8400-e29b-41d4-a716-446655440000",
    "payload": { "…": "…" }
  }]
}
```

الاستجابة:

```json
{
  "results": [{
    "clientOperationId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "accepted",
    "serverId": 991,
    "message": "تم اعتماد القراءة"
  }]
}
```

القيم الممكنة للحالة هي `accepted` و`duplicate` و`rejected` و`retryable`. لا يحذف Android السجل المحلي إلا عند `accepted` أو `duplicate` المؤكد.

## أخطاء API

تعيد الأخطاء بنية ثابتة:

```json
{
  "error": {
    "code": "READING_BELOW_PREVIOUS",
    "message": "القراءة الحالية أقل من القراءة السابقة",
    "retryable": false,
    "details": { "previousReading": "1250.500" }
  }
}
```

## حالات Room المطلوبة

يحتفظ التطبيق بالحقول التالية لكل عملية محلية:

| الحقل | الغرض |
|---|---|
| `clientOperationId` | منع التكرار عبر إعادة المحاولة. |
| `status` | `pending`, `syncing`, `synced`, `failed`. |
| `retryCount` | تحديد عدد المحاولات. |
| `lastError` | عرض سبب الفشل للمستخدم. |
| `serverId` | ربط العملية المحلية بالسجل الخادمي. |
| `updatedAt` | ترتيب ومراقبة آخر تغيير. |

## تعريف الجاهزية للمرحلة التالية

لا تبدأ مرحلة ربط Android قبل اعتماد هذه النقاط: تسجيل دخول حقيقي مرتبط بالمستخدم، endpoint مشتركين حقيقي، endpoint قراءة يقبل `clientOperationId`، نتيجة مزامنة لكل عنصر، حراسة tenant/branch على الخادم، واختبار يعيد طلباً مكرراً دون إنشاء سجل إضافي.
