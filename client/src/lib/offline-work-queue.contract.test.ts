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


describe("HR offline outbox contract", () => {
  it("uses the shared durable operation store and persists dependency metadata in the same transaction", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/lib/offline-work-queue.ts"), "utf8");
    expect(source).toContain('"employee_create"');
    expect(source).toContain('"employee_update"');
    expect(source).toContain('"attendance_upsert"');
    expect(source).toContain('"payroll_draft"');
    expect(source).toContain('"employee_advance_issue"');
    expect(source).toContain('"employee_advance_repayment"');
    expect(source).toContain('export async function enqueueOfflineHrWork(input: OfflineWorkEnqueueInput)');
    expect(source).toContain('db.transaction([storeName, syncMetadataStoreName], "readwrite")');
    expect(source).toContain("metadataStore.add(createInitialSyncMetadataRecord(record, dependsOn))");
    expect(source).toContain("operationsStore.add(record)");
    expect(source).toContain('metadata?.outcome === "pending" && metadata.attempts === 0');
  });

  it("coalesces only unattempted employee and attendance edits and refuses duplicate local payroll periods", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/lib/offline-work-queue.ts"), "utf8");
    expect(source).toContain('if (record.kind === "employee_update")');
    expect(source).toContain('if (record.kind === "attendance_upsert")');
    expect(source).toContain('item.kind === "payroll_draft" && item.status !== "applied" && item.status !== "failed"');
    expect(source).toContain("payload.expectedVersion = input.serverVersion");
    expect(source).toContain("export async function resolveOfflineEmployeeReferences");
    expect(source).toContain("export async function resolveOfflineAdjustmentReferences");
    expect(source).toContain("export function notifyOfflineWorkQueueChanged");
    expect(source).toContain("export function subscribeOfflineWorkQueueChanges");
    expect(source).toContain("OFFLINE_WORK_QUEUE_CHANGED_CHANNEL");
    expect(source).toContain("new BroadcastChannel(OFFLINE_WORK_QUEUE_CHANGED_CHANNEL)");
  });
});
 
describe("HR optimistic version integrity", () => {
  it("never synthesizes a server version during outbox recovery or confirmed writes", () => {
    const syncPanel = readFileSync(resolve(process.cwd(), "client/src/components/OfflineWorkSyncPanel.tsx"), "utf8");
    const employeePage = readFileSync(resolve(process.cwd(), "client/src/pages/HumanResourcesPage.tsx"), "utf8");
    const attendancePage = readFileSync(resolve(process.cwd(), "client/src/pages/AttendancePage.tsx"), "utf8");

    expect(syncPanel).toContain("versionNo: item.appliedVersionNo ?? 0");
    expect(syncPanel).toContain("if (!result.versionNo || result.versionNo < 1)");
    expect(syncPanel).not.toContain("versionNo: item.appliedVersionNo ?? 1");
    expect(syncPanel).not.toContain("appliedVersionNo: result.versionNo ?? expectedVersion + 1");
    expect(syncPanel).not.toContain("appliedVersionNo: result.versionNo ?? 1");
    expect(employeePage).toContain("createdAt: new Date(item.createdAt), versionNo: 0");
    expect(attendancePage).toContain("contractType: payload.contractType, versionNo: 0");
    expect(attendancePage).toContain("versionNo: payload.expectedVersion ?? previous?.attendance.versionNo ?? 0");
  });
});

