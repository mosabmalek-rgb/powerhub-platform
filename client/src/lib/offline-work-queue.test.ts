import { describe, expect, it } from "vitest";
import { createOfflineWork, type GeneratorCreateDraft, type GeneratorUpdateDraft } from "./offline-work-queue";

describe("طابور المسودات دون اتصال", () => {
  it("ينشئ معرف عملية ثابتاً داخل السجل ومعرفاً مختلفاً لكل مسودة", () => {
    const base = { userId: 7, siteId: 3, kind: "subscriber_create" as const, payload: { fullName: "أحمد علي", phone: "+970599000000", subscriptionType: "residential" as const } };
    const first = createOfflineWork(base);
    const second = createOfflineWork(base);
    expect(first.id).toBe(first.clientOperationId);
    expect(first.clientOperationId).not.toBe(second.clientOperationId);
    expect(first.status).toBe("pending");
  });

  it("يحفظ التحصيل كمسودة معلقة من دون تمثيلها كدفعة مكتملة", () => {
    const draft = createOfflineWork({ userId: 7, siteId: 3, kind: "payment_create", payload: { subscriberId: 31, invoiceId: 41, paymentNo: "PAY-OFF-001", amount: 75, paymentMethod: "cash", companyAccountId: 2, receiptImageData: "aGVsbG8=", receiptImageMime: "image/png" } });
    expect(draft).toMatchObject({ kind: "payment_create", status: "pending", payload: { invoiceId: 41, amount: 75, receiptImageMime: "image/png" } });
  });

  it("يحفظ إنشاء المولد مع نطاق المستخدم والفرع", () => {
    const payload: GeneratorCreateDraft = { code: "GEN-001", name: "مولد الاختبار", ratedCapacityKw: "150", fuelType: "diesel" };
    const draft = createOfflineWork({ userId: 17, siteId: 3, kind: "generator_create", payload });
    expect(draft).toMatchObject({ userId: 17, siteId: 3, kind: "generator_create", status: "pending", payload });
    expect(draft.clientOperationId).toBe(draft.id);
  });

  it("يحافظ على optimistic concurrency في تعديل المولد", () => {
    const payload: GeneratorUpdateDraft = { generatorId: 91, name: "مولد رئيسي", ratedCapacityKw: "200", fuelLevelLiters: "80", operatingHours: "421.5", status: "active", expectedUpdatedAt: "2026-09-09T12:00:00.000Z" };
    const draft = createOfflineWork({ userId: 22, siteId: 8, kind: "generator_update", payload });
    expect(draft.payload).toEqual(payload);
    expect(draft.status).toBe("pending");
  });
});
