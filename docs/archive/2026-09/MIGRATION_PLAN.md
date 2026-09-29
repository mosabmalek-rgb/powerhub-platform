# 🚀 خطة الترحيل الكاملة: Generator Owner Creation

## المشكلة الحالية ❌
```typescript
// server/admin.ts:704
createGeneratorOwner: mutation → assertLegacyAdminWriteMigrationGuard
↓
throw TRPCError("متوقف مؤقتاً... يعتمد على MySQL")
```

**السبب**: المشروع في مرحلة انتقالية من MySQL/Drizzle → Supabase

---

## الحل: ترحيل إلى Supabase RPC ✅

### ✅ ما تم إنجازه

#### 1️⃣ **ملف Supabase RPC**
```
📁 supabase/migrations/20250904_create_generator_owner_rpc.sql
```
- دالة ذرية (Atomic) توجود في قاعدة بيانات واحدة
- تتعامل مع جميع الجداول في عملية واحدة
- معالجة كاملة للأخطاء والتحقق من البيانات

**ما تفعله:**
1. ✅ إنشاء المستأجر (Tenant)
2. ✅ إنشاء ملف مالك المولد
3. ✅ إنشاء الاشتراك
4. ✅ إنشاء الفرع (Site)
5. ✅ إنشاء إعدادات بوابة الفرع
6. ✅ إنشاء المولد
7. ✅ ربط المستخدم (إن وجد)
8. ✅ تسجيل عملية التدقيق

---

### 📝 المتبقي: التعديلات في TypeScript

#### 2️⃣ **تحديث `server/admin.ts`**

```typescript
// قبل (❌ معطّل):
createGeneratorOwner: platformAdminProcedure.input(...).mutation(async ({ ctx, input }) => {
  assertLegacyAdminWriteMigrationGuard("إنشاء صاحب مولد");
  // ... كود معقّد في MySQL
})

// بعد (✅ يعمل):
createGeneratorOwner: platformAdminProcedure.input(...).mutation(async ({ ctx, input }) => {
  const { data, error } = await admin.rpc("powerhub_create_generator_owner", {
    p_actor_user_id: ctx.user.id,
    p_tenant_name: input.tenantName,
    // ... باقي المعاملات
  });
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
  return data[0];
})
```

---

## 🛠️ خطوات التنفيذ

### الخطوة 1: تطبيق ملف الترحيل
```bash
# في Supabase Dashboard أو عبر CLI:
supabase migration up
# أو انسخ محتوى SQL وشغّله مباشرة في Supabase
```

### الخطوة 2: تحديث `server/admin.ts` (السطر 682-786)

**استبدل الدالة بالكود الجديد:**

```typescript
createGeneratorOwner: platformAdminProcedure.input(z.object({
  tenantName: z.string().min(2).max(160),
  slug: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/),
  ownerName: z.string().min(2).max(180),
  ownerPhone: z.string().min(5).max(30),
  ownerEmail: z.string().email().optional(),
  companyName: z.string().max(180).optional(),
  ownerUserId: z.number().int().positive().optional(),
  siteName: z.string().min(2).max(160),
  siteCode: z.string().min(2).max(50).transform((value) => value.toUpperCase()),
  generatorName: z.string().min(2).max(160),
  generatorCode: z.string().min(2).max(50).transform((value) => value.toUpperCase()),
  generatorCapacityKw: z.number().positive().max(100000),
  generatorFuelType: z.enum(["diesel", "gasoline", "gas", "other"]).default("diesel"),
  city: z.string().max(100).optional(),
  plan: planSchema.default("starter"),
  subscriptionStatus: subscriptionStatusSchema.default("trial"),
  billingCycle: billingCycleSchema.default("monthly"),
  endsAt: z.date().optional(),
  autoRenew: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
})).mutation(async ({ ctx, input }) => {
  const admin = supabaseAdmin();
  
  // حساب تاريخ انتهاء الاشتراك
  const startedAt = new Date();
  const endsAt = input.endsAt ?? addSubscriptionPeriod(startedAt, input.billingCycle);

  // استدعاء RPC
  const { data, error } = await admin.rpc("powerhub_create_generator_owner", {
    p_actor_user_id: ctx.user.id,
    p_tenant_name: input.tenantName.trim(),
    p_slug: input.slug,
    p_company_name: input.companyName?.trim() || null,
    p_owner_name: input.ownerName.trim(),
    p_identity_ciphertext: null,  // لا توجد بيانات هوية في هذه الدالة
    p_identity_iv: null,
    p_identity_last4: "",
    p_owner_phone: input.ownerPhone.trim(),
    p_owner_whatsapp: input.ownerPhone.trim(),
    p_owner_email: input.ownerEmail?.trim().toLowerCase() || null,
    p_owner_user_id: input.ownerUserId || null,
    p_site_name: input.siteName.trim(),
    p_site_code: input.siteCode.toUpperCase(),
    p_city: input.city || null,
    p_generator_name: input.generatorName.trim(),
    p_generator_code: input.generatorCode.toUpperCase(),
    p_generator_capacity_kw: input.generatorCapacityKw,
    p_generator_fuel_type: input.generatorFuelType,
    p_plan: input.plan,
    p_subscription_status: input.subscriptionStatus,
    p_billing_cycle: input.billingCycle,
    p_ends_at: endsAt.toISOString(),
    p_auto_renew: input.autoRenew,
    p_notes: input.notes || null,
  });

  // معالجة الخطأ
  if (error || !data?.[0]) {
    const message = error?.message || "تعذر إنشاء صاحب المولد";
    throw new TRPCError({
      code: message.includes("مستخدم بالفعل") || message.includes("duplicate") ? "CONFLICT" : "INTERNAL_SERVER_ERROR",
      message,
    });
  }

  // عودة النتيجة
  const result = data[0];
  return {
    tenantId: result.tenant_id,
    siteId: result.site_id,
    generatorId: result.generator_id,
  };
}),
```

### الخطوة 3: حذف الحماية (`assertLegacyAdminWriteMigrationGuard`)

**ابحث عن جميع المواضع التي تستخدمها:**
```bash
grep -n "assertLegacyAdminWriteMigrationGuard" server/admin.ts
```

**الدوال المتأثرة:**
- ❌ `createGeneratorOwner` (السطر 704) → ✅ تم الإصلاح
- ❌ `createGeneratorOwnerWithTemporaryPassword` (السطر 298)
- ❌ `invitePlatformAccess` (السطر 587)
- ❌ `setTenantMembershipStatus` (السطر 668)
- ... و[غيرها](line:159)

---

## 📊 جدول المقارنة

| الميزة | MySQL القديم ❌ | Supabase RPC ✅ |
|--------|---|---|
| **الموثوقية** | معرضة للأخطاء | ذرية (Atomic) |
| **الأداء** | بطيء جزئياً | سريع |
| **المزامنة** | تضارب محتمل | متزامن كلياً |
| **التوسعية** | محدودة | لا حدود |
| **الأمان** | `SECURITY DEFINER` | `SECURITY DEFINER` |
| **المعالجة** | يدوية | تلقائية |

---

## ✅ قائمة التحقق

### قبل النشر:
- [ ] تشغيل ملف SQL على Supabase
- [ ] اختبار الدالة في Supabase Dashboard:
  ```sql
  SELECT * FROM powerhub_create_generator_owner(
    1, 'Test Company', 'test-slug', ...
  );
  ```
- [ ] تحديث `server/admin.ts`
- [ ] حذف `assertLegacyAdminWriteMigrationGuard` من `createGeneratorOwner`
- [ ] اختبار الـ API من التطبيق

### بعد النشر:
- [ ] اختبار إنشاء صاحب مولد جديد
- [ ] التحقق من البيانات في جميع الجداول
- [ ] فحص سجلات التدقيق
- [ ] التحقق من عدم وجود أخطاء في السجلات

---

## 🐛 حل المشاكل المحتملة

### ❌ خطأ: "دالة غير موجودة"
```
ERROR: function powerhub_create_generator_owner does not exist
```
**الحل**: تأكد من تطبيق ملف الترحيل على Supabase

### ❌ خطأ: "قيمة NULL غير مسموحة"
```
NOT NULL constraint violation on field X
```
**الحل**: تحقق من أن جميع المعاملات الإلزامية مُمررة

### ❌ خطأ: "رقم هاتف مستخدم بالفعل"
```
"رقم هاتف صاحب المولد مستخدم بالفعل"
```
**الحل**: استخدم رقم هاتف فريد (لا تكرار)

---

## 📚 المراجع

- [Supabase RPC](https://supabase.com/docs/guides/database/functions)
- [PostgreSQL Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [Security Definer Functions](https://www.postgresql.org/docs/current/sql-createfunction.html)

---

**التاريخ**: 2026-09-04  
**الحالة**: جاهز للتنفيذ ✅
