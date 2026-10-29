import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { blocksDuplicateOfflinePayrollPeriod, createOfflineLocalEntityId, createOfflineWork, type FuelFillDraft, type GeneratorCreateDraft, type GeneratorUpdateDraft, type QueuedOfflineWork } from "./offline-work-queue";

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


describe("offline fuel fill intent contract", () => {
  it("persists fuel fill as a pending scoped intent with a stable operation key", () => {
    const payload: FuelFillDraft = {
      generatorId: 11, fuelItemId: 9, sourceWarehouseId: 2, destinationWarehouseId: 7,
      litres: 25.5, occurredAt: "2026-10-29T12:30:00.000Z",
      levelBeforeLiters: 10, levelAfterLiters: 35.5, operatingHours: 120.25,
    };
    const item = createOfflineWork({ userId: 7, tenantId: 5, siteId: 3, kind: "fuel_fill", clientOperationId: "fuel-fill:op-1", payload });
    expect(item.kind).toBe("fuel_fill");
    expect(item.clientOperationId).toBe("fuel-fill:op-1");
    expect(item.status).toBe("pending");
    expect(item.userId).toBe(7);
    expect(item.tenantId).toBe(5);
    expect(item.siteId).toBe(3);
    expect(item.payload).toEqual(payload);
  });
}
  it("queues only a local intent and marks it applied only after the protected replay returns", () => {
    const fuelPanel = readFileSync(resolve(process.cwd(), "client/src/components/InventoryFuelConsumptionPanel.tsx"), "utf8");
    const syncPanel = readFileSync(resolve(process.cwd(), "client/src/components/OfflineWorkSyncPanel.tsx"), "utf8");
    const router = readFileSync(resolve(process.cwd(), "server/powerhub-inventory-router.ts"), "utf8");

    const submitStart = fuelPanel.indexOf("const submitFill =");
    const submitEnd = fuelPanel.indexOf("const submitReading =", submitStart);
    expect(submitStart).toBeGreaterThanOrEqual(0);
    expect(submitEnd).toBeGreaterThan(submitStart);
    const submit = fuelPanel.slice(submitStart, submitEnd);
    expect(submit).toContain("if (reachability === false)");
    expect(submit).toContain('kind: "fuel_fill", clientOperationId: fillKey, payload');
    expect(submit).toContain('fillMutation.mutate({ siteId, ...payload, operationKey: fillKey })');
    expect(submit).not.toContain("updateOfflineWork(");
    expect(submit).not.toContain("stockOverview.setData");
    expect(submit).not.toContain("listStockMovements.setData");

    const replayStart = syncPanel.indexOf('if (item.kind === "fuel_fill")');
    const replayEnd = syncPanel.indexOf('const payload = item.payload as import("@/lib/offline-work-queue").PaymentDocumentationDraft;', replayStart);
    expect(replayStart).toBeGreaterThanOrEqual(0);
    expect(replayEnd).toBeGreaterThan(replayStart);
    const replay = syncPanel.slice(replayStart, replayEnd);
    const requestIndex = replay.indexOf("await recordFuelFill.mutateAsync");
    const appliedIndex = replay.indexOf('status: "applied"');
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(appliedIndex).toBeGreaterThan(requestIndex);
    expect(replay).toContain("operationKey: item.clientOperationId");
    expect(replay).toContain("result.replayed ? \"already_applied\" : \"applied\"");

    const serverStart = router.indexOf("recordFuelFill: protectedProcedure");
    const serverEnd = router.indexOf("recordFuelReading: protectedProcedure", serverStart);
    expect(serverStart).toBeGreaterThanOrEqual(0);
    expect(serverEnd).toBeGreaterThan(serverStart);
    const serverProcedure = router.slice(serverStart, serverEnd);
    expect(serverProcedure).toContain('"manageFuelAndConsumption"');
    expect(serverProcedure).toContain('"powerhub_inventory_record_fuel_fill"');
    expect(serverProcedure).toContain("p_operation_key: input.operationKey");
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
    expect(source).toContain("blocksDuplicateOfflinePayrollPeriod(item, {");
    expect(source).not.toContain('item.kind === "payroll_draft" && item.status !== "applied" && item.status !== "failed"');
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

describe("HR local identifiers and payroll deduplication", () => {
  it("generates unique negative safe-integer IDs without depending on wall-clock time", () => {
    const ids = Array.from({ length: 1_000 }, () => createOfflineLocalEntityId());
    expect(ids.every((id) => Number.isSafeInteger(id) && id < 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("blocks duplicate periods for pending, ambiguous, conflicted, applied, or untracked operations", () => {
    const base = createOfflineWork({
      userId: 7, siteId: 3, kind: "payroll_draft",
      payload: { period: "2026-10", items: [{ employeeId: 11, extraAmount: 0, advanceDeduction: 0, otherDeduction: 0 }] },
    });
    const scope = { userId: 7, siteId: 3, period: "2026-10" };
    const meta = (outcome: "pending" | "syncing" | "retryable" | "conflict" | "rejected" | "applied") => ({
      operationId: base.clientOperationId, userId: 7, siteId: 3, kind: "payroll_draft",
      dependsOn: [], attempts: 1, nextAttemptAt: 0, outcome, updatedAt: 1,
    });

    expect(blocksDuplicateOfflinePayrollPeriod({ ...base, status: "pending" }, scope, meta("pending"))).toBe(true);
    expect(blocksDuplicateOfflinePayrollPeriod({ ...base, status: "failed" }, scope, meta("retryable"))).toBe(true);
    expect(blocksDuplicateOfflinePayrollPeriod({ ...base, status: "failed" }, scope, meta("syncing"))).toBe(true);
    expect(blocksDuplicateOfflinePayrollPeriod({ ...base, status: "failed" }, scope, undefined)).toBe(true);
    expect(blocksDuplicateOfflinePayrollPeriod({ ...base, status: "conflict" }, scope, meta("conflict"))).toBe(true);
    expect(blocksDuplicateOfflinePayrollPeriod({ ...base, status: "applied" }, scope, meta("applied"))).toBe(true);
    expect(blocksDuplicateOfflinePayrollPeriod({ ...base, status: "failed" }, scope, meta("rejected"))).toBe(false);
    expect(blocksDuplicateOfflinePayrollPeriod(base, { ...scope, period: "2026-09" }, meta("pending"))).toBe(false);
    expect(blocksDuplicateOfflinePayrollPeriod({ ...base, siteId: 4 }, scope, meta("pending"))).toBe(false);
  });

  it("uses random negative IDs for HR local employee, attendance, and advance references", () => {
    const employeePage = readFileSync(resolve(process.cwd(), "client/src/pages/HumanResourcesPage.tsx"), "utf8");
    const attendancePage = readFileSync(resolve(process.cwd(), "client/src/pages/AttendancePage.tsx"), "utf8");
    const advancesPage = readFileSync(resolve(process.cwd(), "client/src/pages/EmployeeAdvancesPage.tsx"), "utf8");
    expect(employeePage).toContain("const localEmployeeId = createOfflineLocalEntityId()");
    expect(attendancePage).toContain("existing?.attendance.id ?? createOfflineLocalEntityId()");
    expect(advancesPage).toContain("const localAdjustmentId=createOfflineLocalEntityId()");
    expect(advancesPage).toContain("const localRepaymentId=createOfflineLocalEntityId()");
    expect(employeePage).not.toContain("const localEmployeeId = -Date.now()");
    expect(attendancePage).not.toContain("?? -Date.now()");
    expect(advancesPage).not.toContain("=-Date.now()");
  });
});

