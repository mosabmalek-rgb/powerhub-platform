import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("preserves update identity, operational fields, and optimistic concurrency token", () => {
    const payload: GeneratorUpdateDraft = {
      generatorId: 11,
      name: "المولد الاحتياطي",
      ratedCapacityKw: "80",
      fuelLevelLiters: "42",
      operatingHours: "120.5",
      status: "maintenance",
      expectedUpdatedAt: "2026-09-09T12:00:00.000Z",
    };
    const item = createOfflineWork({ userId: 7, siteId: 3, kind: "generator_update", payload });
    expect(item.kind).toBe("generator_update");
    expect(item.payload).toEqual(payload);
    expect((item.payload as GeneratorUpdateDraft).expectedUpdatedAt).toBe("2026-09-09T12:00:00.000Z");
  });
});


describe("offline outbox update atomicity contract", () => {
  it("reads and writes an operation within one readwrite IndexedDB transaction", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/lib/offline-work-queue.ts"), "utf8");
    const start = source.indexOf("export async function updateOfflineWork(");
    const end = source.indexOf("export async function requeueOfflineWorkForManualRetry(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const implementation = source.slice(start, end);

    expect(implementation).toContain('database.transaction(storeName, "readwrite")');
    expect(implementation).toContain("const request = store.get(id)");
    expect(implementation).toContain("store.put({ ...existing, ...patch, updatedAt: Date.now() })");
    expect(implementation).not.toContain('transact<QueuedOfflineWork | undefined>("readonly"');
  });
});
