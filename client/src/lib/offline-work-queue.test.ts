import { describe, expect, it } from "vitest";
import { canRequeueFailedOfflineWork, canRequeueOfflineWorkForManualRecovery, createInitialSyncMetadataRecord, createOfflineWork, isSyncMetadataCompatibleWithWorkItem, type GeneratorCreateDraft, type GeneratorUpdateDraft, type ReadingCreateDraft, type ExpenseCreateDraft } from "./offline-work-queue";
import { SYNC_MAX_ATTEMPTS } from "./offline-sync-engine";

describe("طابور المسودات دون اتصال", () => {
  it("ينشئ معرف عملية ثابتاً داخل السجل ومعرفاً مختلفاً لكل مسودة", () => {
    const base = { userId: 7, siteId: 3, kind: "subscriber_create" as const, payload: { fullName: "أحمد علي", phone: "+970599000000", subscriptionType: "residential" as const } };
    const first = createOfflineWork(base);
    const second = createOfflineWork(base);
    expect(first.id).toBe(first.clientOperationId);
    expect(first.clientOperationId).not.toBe(second.clientOperationId);
    expect(first.status).toBe("pending");
  });

  it("ينشئ بيانات مزامنة أولية بنفس نطاق ومعرف العملية", () => {
    const draft = createOfflineWork({
      userId: 7, tenantId: 2, siteId: 3, kind: "payment_create",
      payload: { subscriberId: 31, invoiceId: 41, paymentNo: "PAY-OFF-002", amount: 25, paymentMethod: "cash", companyAccountId: 2 },
    });
    expect(createInitialSyncMetadataRecord(draft)).toEqual({
      operationId: draft.clientOperationId, userId: 7, tenantId: 2, siteId: 3,
      kind: "payment_create", dependsOn: [], attempts: 0,
      nextAttemptAt: draft.createdAt, outcome: "pending", updatedAt: draft.createdAt,
    });
  });
  it("rejects missing or mismatched sync metadata rather than trusting its operation ID alone", () => {
    const draft = createOfflineWork({
      userId: 7, tenantId: 2, siteId: 3, kind: "payment_create",
      payload: { subscriberId: 31, invoiceId: 41, paymentNo: "PAY-OFF-003", amount: 15, paymentMethod: "cash", companyAccountId: 2 },
    });
    const metadata = createInitialSyncMetadataRecord(draft);
    expect(isSyncMetadataCompatibleWithWorkItem(draft, metadata)).toBe(true);
    expect(isSyncMetadataCompatibleWithWorkItem(draft, undefined)).toBe(false);
    expect(isSyncMetadataCompatibleWithWorkItem(draft, { ...metadata, tenantId: 99 })).toBe(false);
    expect(isSyncMetadataCompatibleWithWorkItem(draft, { ...metadata, kind: "reading_create" })).toBe(false);
    expect(isSyncMetadataCompatibleWithWorkItem(draft, { ...metadata, siteId: 8 })).toBe(false);
    expect(isSyncMetadataCompatibleWithWorkItem(draft, { ...metadata, userId: 8 })).toBe(false);
    expect(canRequeueFailedOfflineWork({ ...draft, status: "failed" }, { ...metadata, outcome: "retryable" })).toBe(true);
    expect(canRequeueFailedOfflineWork({ ...draft, status: "failed" }, metadata)).toBe(false);
    expect(canRequeueFailedOfflineWork({ ...draft, status: "failed" }, { ...metadata, tenantId: 99, outcome: "retryable" })).toBe(false);
    expect(canRequeueFailedOfflineWork({ ...draft, status: "failed" }, { ...metadata, kind: "reading_create", outcome: "retryable" })).toBe(false);
    expect(canRequeueFailedOfflineWork({ ...draft, status: "pending" }, { ...metadata, outcome: "retryable" })).toBe(false);
  });


  it("allows recovery only for exhausted ambiguous sends with matching scope", () => {
    const draft = createOfflineWork({
      userId: 7, tenantId: 2, siteId: 3, kind: "payment_create",
      payload: { subscriberId: 31, invoiceId: 41, paymentNo: "PAY-OFF-RECOVERY", amount: 15, paymentMethod: "cash", companyAccountId: 2 },
    });
    const syncing = { ...createInitialSyncMetadataRecord(draft), outcome: "syncing" as const, attempts: SYNC_MAX_ATTEMPTS };
    expect(canRequeueOfflineWorkForManualRecovery({ ...draft, status: "pending" }, syncing)).toBe(true);
    expect(canRequeueOfflineWorkForManualRecovery({ ...draft, status: "failed" }, syncing)).toBe(true);
    expect(canRequeueOfflineWorkForManualRecovery({ ...draft, status: "pending" }, { ...syncing, attempts: SYNC_MAX_ATTEMPTS - 1 })).toBe(false);
    expect(canRequeueOfflineWorkForManualRecovery({ ...draft, status: "conflict" }, syncing)).toBe(false);
    expect(canRequeueOfflineWorkForManualRecovery({ ...draft, status: "pending" }, { ...syncing, tenantId: 999 })).toBe(false);
  });

  it("allows manual recovery when a pending row has exhausted retryable metadata", () => {
    const draft = createOfflineWork({
      userId: 7, tenantId: 2, siteId: 3, kind: "payment_create",
      payload: { subscriberId: 31, invoiceId: 41, paymentNo: "PAY-OFF-RETRY-CEILING", amount: 15, paymentMethod: "cash", companyAccountId: 2 },
    });
    const retryable = { ...createInitialSyncMetadataRecord(draft), outcome: "retryable" as const, attempts: SYNC_MAX_ATTEMPTS };
    expect(canRequeueOfflineWorkForManualRecovery({ ...draft, status: "pending" }, retryable)).toBe(true);
    expect(canRequeueOfflineWorkForManualRecovery({ ...draft, status: "pending" }, { ...retryable, attempts: SYNC_MAX_ATTEMPTS - 1 })).toBe(false);
  });

  it("يدرج القراءة الميدانية في Outbox مع الاحتفاظ بمعرف العملية", () => {
    const payload: ReadingCreateDraft = {
      subscriberId: 31, readingValue: "125.5", readingAt: "2026-10-24T10:00:00.000Z",
      captureMethod: "photo", imageData: "aGVsbG8=", imageMime: "image/jpeg", fieldVerified: true,
    };
    const draft = createOfflineWork({
      userId: 7, tenantId: 2, siteId: 3, kind: "reading_create",
      payload, clientOperationId: "field-reading-op-1",
    });
    expect(draft).toMatchObject({
      id: "field-reading-op-1", clientOperationId: "field-reading-op-1",
      userId: 7, tenantId: 2, siteId: 3, kind: "reading_create", status: "pending", payload,
    });
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


describe("expense Outbox intent", () => {
  it("stores a pending expense request with a stable idempotency key and no local posting claim", () => {
    const payload: ExpenseCreateDraft = {
      companyAccountId: 4, category: "fuel", description: "شراء ديزل", amount: 125,
      referenceNo: "LOCAL-REF",
    };
    const item = createOfflineWork({
      userId: 7, tenantId: 2, siteId: 3, kind: "expense_create",
      clientOperationId: "8b9fda8e-7d36-4f3b-9d95-3f3a0e30f5f0", payload,
    });
    expect(item).toMatchObject({
      status: "pending", kind: "expense_create", clientOperationId: "8b9fda8e-7d36-4f3b-9d95-3f3a0e30f5f0",
      payload: { companyAccountId: 4, amount: 125, description: "شراء ديزل" },
    });
    expect(item).not.toHaveProperty("appliedEntityId");
  });
});
