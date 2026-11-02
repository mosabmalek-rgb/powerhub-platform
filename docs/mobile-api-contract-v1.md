# عقد تكامل تطبيق Android مع PowerHub — Mobile API v1

## الهدف والنطاق

يوثق هذا الملف واجهات REST الموجودة فعليًا في `server/mobile-api.ts`. لا يَعِد بمسارات رفع صور منفصلة أو مزامنة مجمعة؛ لم يتم تنفيذ تلك الواجهات بعد. يظل Android مسؤولًا عن Outbox محلي وإعادة إرسال كل قراءة منفردة باستخدام `clientOperationId` ثابت.

## قواعد عامة

| القاعدة | القرار |
|---|---|
| الإصدار | كل المسارات تبدأ بـ `/api/mobile/v1`. |
| النقل | HTTPS فقط خارج بيئة التطوير المحلية. |
| المصادقة | Bearer access token قصير العمر؛ refresh token يرسل فقط إلى مسار التجديد. |
| الوقت | ISO-8601 مع منطقة زمنية، ويفضل UTC. |
| الأرقام | `readingValue` نص عشري للحفاظ على دقة PostgreSQL numeric. |
| العزل | الخادم يستخرج tenant والفروع من الجلسة والعضوية؛ لا يثق بمعرفات العميل وحدها. |
| إعادة المحاولة | `clientOperationId` UUID ثابت لكل عملية قراءة ولا يتغير بين المحاولات. |

## المسارات المنفذة

| الطريقة | المسار | الوظيفة |
|---|---|---|
| POST | `/auth/login` | تسجيل الدخول وإنشاء جلسة جهاز واحد |
| POST | `/auth/change-password` | تغيير كلمة مرور مؤقتة |
| POST | `/auth/refresh` | تجديد الجلسة |
| POST | `/auth/logout` | إلغاء الجلسة الحالية |
| GET | `/auth/me` | هوية المستخدم ونطاقه الحالي |
| GET | `/reading-cycle` | إعداد وحدود الدورة |
| GET | `/reading-cycle-sync-stats` | إحصاء القراءات المزامنة في نطاق زمني |
| GET | `/subscribers` | قائمة المشتركين المسموح بها |
| POST | `/readings` | تسجيل قراءة واحدة |
| POST | `/sync-events` | تسجيل حدث مزامنة واحد (قياس/تدقيق فقط، وليس رفع دفعة) |

لا يوجد حاليًا `POST /uploads/meter-photo` أو `POST /sync`. رفع صورة القراءة يتم ضمن طلب `POST /readings` عبر `imageData` و`imageMime`.

## المصادقة

تستخدم واجهة الدخول البريد الإلكتروني وكلمة المرور:

```json
{ "email": "field.user@example.com", "password": "••••••••", "tenantId": 7, "deviceLabel": "Android Field Reader" }
```

يجب تخزين access/refresh tokens في Android Keystore أو آلية آمنة مكافئة، وعدم وضعها في SharedPreferences العادية أو السجلات. اختيار المستأجر مطلوب عندما يكون للحساب أكثر من عضوية فعالة غير منتهية.

## المشتركين

```text
GET /api/mobile/v1/subscribers?branchId=12&cursor=0&limit=100
```

يعيد الخادم `items` و`currentCycle` و`nextCursor`. تتضمن بيانات المشترك: `id`, `subscriberNo`, `fullName`, `phone`, `address`, `branchId`, `lastReading`, `lastReadingAt`, `hasReadingInCurrentCycle`, `currentCycleReading`. لا يرسل هذا المسار `meterId` في التنفيذ الحالي.

عند تفعيل توزيع مدخلي القراءة، يعيد الخادم المشتركين المسندين إلى المستخدم الحالي فقط. وعند تعطيل التوزيع يبقى نطاق المشتركين الكامل وفق صلاحية الفرع.

## إرسال قراءة واحدة

```text
POST /api/mobile/v1/readings
Content-Type: application/json
```

الحقول المقبولة حاليًا (المخطط صارم ويرفض الحقول غير المعروفة):

```json
{
  "clientOperationId": "550e8400-e29b-41d4-a716-446655440000",
  "branchId": 12,
  "subscriberId": 456,
  "readingValue": "1250.500",
  "readingAt": "2026-08-22T14:30:00.000Z",
  "captureMethod": "photo",
  "isReadingReset": false,
  "fieldVerified": true,
  "latitude": 31.9,
  "longitude": 35.2,
  "imageData": "<base64>",
  "imageMime": "image/jpeg",
  "notes": "قراءة ميدانية"
}
```

`captureMethod` إحدى `manual`, `photo`, `smart_meter`. حقلا الصورة اختياريان؛ عند إرسال `imageData` يجب إرسال `imageMime` من `image/jpeg`, `image/png`, `image/webp`. الحد الأقصى للصورة 7 MiB بعد فك Base64. الحقول `meterId`, `isMeterReplacement`, `photoUploadId` غير مدعومة في المخطط الحالي.

التحقق الذري في قاعدة البيانات يعيد فحص أهلية العضوية والإسناد بعد قفل صف المشترك، ثم يحفظ القراءة وسجل التدقيق ضمن المعاملة نفسها. إذا نُقل المشترك بعد نجاح الحفظ وضاعت الاستجابة، يعيد المرسل الأصلي نتيجة العملية السابقة باستخدام UUID نفسه؛ لا يُسمح له بإنشاء قراءة جديدة بعد النقل.

الاستجابات:
- `201`: قراءة جديدة، مع `replayed: false`.
- `200`: إقرار إعادة إرسال عملية محفوظة، مع `replayed: true`.
- `409`: تعارض دورة القراءة أو إعادة استخدام مفتاح العملية لقراءة أخرى.
- `403`: لم يعد المستخدم مؤهلًا أو لم يعد المشترك مسندًا إليه.
- `503`: تعذر الوصول إلى قاعدة البيانات/الخدمة، ويمكن إعادة المحاولة بحذر باستخدام UUID نفسه.

## أحداث المزامنة

`POST /api/mobile/v1/sync-events` يسجل حدثًا واحدًا من نوع `sync_cycle` أو `sync_error`. لا يرفع قراءات مجمعة ولا يقرّ بقبول Outbox؛ يجب إرسال كل قراءة إلى `/readings` والحفاظ على سجلها المحلي حتى استلام `201` أو `200 replayed` المؤكد.

## بنية الخطأ

```json
{
  "error": {
    "code": "READING_BELOW_PREVIOUS",
    "message": "القراءة الحالية أقل من القراءة المعتمدة السابقة.",
    "retryable": false
  }
}
```

## مسؤولية Android / Room

يحفظ Android على الأقل: `clientOperationId`, `status`, `retryCount`, `lastError`, `serverId`, `updatedAt`. لا يحذف العملية المحلية قبل إقرار الخادم. يجب ألا يعاد توليد UUID عند إعادة المحاولة، وألا يغيّر العميل payload لعملية سبق قبولها.
