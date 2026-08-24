import { describe, expect, it } from "vitest";
import { createOfflineWork } from "./offline-work-queue";

describe("طابور المسودات دون اتصال", () => {
  it("ينشئ معرف عملية ثابتاً داخل السجل ومعرفاً مختلفاً لكل مسودة", () => {
    const base = { userId: 7, siteId: 3, kind: "subscriber_create" as const, payload: { fullName: "أحمد علي", phone: "+970599000000", subscriptionType: "residential" as const } };
    const first = createOfflineWork(base);
    const second = createOfflineWork(base);
    expect(first.id).toBe(first.clientOperationId);
    expect(first.clientOperationId).not.toBe(second.clientOperationId);
    expect(first.status).toBe("pending");
  });
});
