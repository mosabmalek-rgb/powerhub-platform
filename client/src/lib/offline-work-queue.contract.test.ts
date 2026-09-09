import { describe, expect, it } from "vitest";
import { createOfflineWork, type GeneratorCreateDraft, type GeneratorUpdateDraft } from "./offline-work-queue";

describe("offline generator queue contract", () => {
  it("creates a scoped generator create operation with a stable client operation id", () => {
    const payload: GeneratorCreateDraft = {
      code: "GEN-01",
      name: "المولد الرئيسي",
      ratedCapacityKw: "100",
      fuelType: "diesel",
    };
    const item = createOfflineWork({ userId: 7, siteId: 3, kind: "generator_create", payload });
    expect(item.clientOperationId).toBe(item.id);
    expect(item.status).toBe("pending");
    expect(item.userId).toBe(7);
    expect(item.siteId).toBe(3);
    expect(item.payload).toEqual(payload);
  });

  it("preserves update identity and operational fields", () => {
    const payload: GeneratorUpdateDraft = {
      generatorId: 11,
      name: "المولد الاحتياطي",
      ratedCapacityKw: "80",
      fuelLevelLiters: "42",
      operatingHours: "120.5",
      status: "maintenance",
    };
    const item = createOfflineWork({ userId: 7, siteId: 3, kind: "generator_update", payload });
    expect(item.kind).toBe("generator_update");
    expect(item.payload).toEqual(payload);
  });
});
