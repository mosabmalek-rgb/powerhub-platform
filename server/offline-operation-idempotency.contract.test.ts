import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const idempotency = read("client/src/lib/offline-operation-idempotency.ts");
const fuel = read("client/src/components/InventoryFuelConsumptionPanel.tsx");
const maintenance = read("client/src/components/InventoryMaintenancePanel.tsx");
const replay = read("client/src/components/OfflineWorkSyncPanel.tsx");

describe("reload-safe fuel and maintenance idempotency contracts", () => {
  it("serializes same-scope key creation in a readwrite transaction and stores no business payload", () => {
    expect(idempotency).toContain('const DATABASE_NAME = "powerhub-operation-idempotency"');
    expect(idempotency).toContain("STABLE_OPERATION_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000");
    expect(idempotency).toContain('database.transaction(STORE_NAME, "readwrite")');
    expect(idempotency).toContain('store.createIndex("byOperationKey", "operationKey"');
    expect(idempotency).toContain('crypto.subtle.digest("SHA-256", bytes)');
    expect(idempotency).toContain('const key = [scope.userId, scope.siteId, scope.kind.trim(), fingerprint].join(":")');
    expect(idempotency).toContain("export async function runWithStableOperationKey");
    expect(idempotency).toContain("await clearStableOperationKey(operationKey).catch(() => undefined)");
    expect(idempotency).not.toContain("payload: scope.payload");
  });

  it("uses persisted keys for connected and offline fuel intents and retains them until server replay succeeds", () => {
    expect(fuel).toContain('kind: "fuel_fill", payload');
    expect(fuel).toContain("clientOperationId, payload");
    expect(fuel).toContain('kind: "fuel_reading", payload');
    expect(fuel).toContain('kind: "fuel_alert_settings", payload');
    expect(fuel).not.toContain("fillKey");
    expect(fuel).not.toContain("readingKey");
    expect(fuel).not.toContain("alertSettingKey");
    const start = replay.indexOf('if (item.kind === "fuel_fill")');
    const end = replay.indexOf('if (item.kind === "inventory_stocktake_count")', start);
    const fuelReplay = replay.slice(start, end);
    expect(fuelReplay.indexOf("recordFuelFill.mutateAsync")).toBeGreaterThanOrEqual(0);
    expect(fuelReplay.indexOf("recordFuelFill.mutateAsync")).toBeLessThan(fuelReplay.indexOf("clearStableOperationKey"));
    expect(fuelReplay).toContain("clearStableOperationKey(item.clientOperationId)");
  });

  it("uses a stable scoped operation identity for every maintenance mutation, including supplier and part operations", () => {
    for (const kind of [
      "maintenance_work_order_create",
      "maintenance_preventive_plan",
      "maintenance_part_issue",
      "maintenance_supplier_assignment",
      "maintenance_reopen",
      'kind: "maintenance_transition_" + action',
    ]) {
      expect(maintenance).toContain(kind);
    }
    expect(maintenance).toContain('operationKey.replace(/-/g, "").slice(0, 8).toUpperCase()');
    expect(maintenance).not.toContain("operationKey(");
    expect(maintenance).toContain("transition.mutateAsync");
    expect(maintenance).toContain("reopenCompleted.mutateAsync");
  });

  it("uses durable cross-tab operation identity for stock movements, returns, corrections, and warehouse transfers", () => {
    const stock = read("client/src/components/InventoryStockOperationsPanel.tsx");
    const transfer = read("client/src/components/InventoryWarehouseTransferPanel.tsx");
    expect(stock).toContain('kind: "inventory_stock_movement", payload');
    expect(stock).toContain('recordMovement.mutateAsync({ ...payload, operationKey })');
    expect(stock).toContain('kind: "inventory_issue_return", payload');
    expect(stock).toContain('returnFromIssue.mutateAsync({ ...payload, operationKey })');
    expect(stock).toContain('kind: "inventory_movement_correction", payload');
    expect(stock).toContain('correctMovement.mutateAsync({ ...payload, operationKey })');
    expect(stock).not.toContain("recordMovement.mutate({");
    expect(stock).not.toContain("returnFromIssue.mutate({");
    expect(stock).not.toContain("correctMovement.mutate({");
    expect(transfer).toContain('kind: "inventory_stock_transfer", payload');
    expect(transfer).toContain('transfer.mutateAsync({ ...payload, operationKey })');
    expect(transfer).not.toContain("function operationKey()");
    expect(transfer).not.toContain("transfer.mutate({");
  });

  it("uses durable operation identity for purchase creation, receipts, supplier payments and returns", () => {
    const purchases = read("client/src/components/InventoryPurchasesPanel.tsx");
    for (const kind of [
      "inventory_purchase_create", "inventory_purchase_receipt",
      "inventory_supplier_payment", "inventory_supplier_return",
    ]) {
      expect(purchases).toContain(`kind: "${kind}", payload`);
    }
    expect(purchases).toContain("createPurchase.mutateAsync({ ...payload, operationKey })");
    expect(purchases).toContain("receivePurchase.mutateAsync({ ...payload, operationKey })");
    expect(purchases).toContain("recordSupplierPayment.mutateAsync({ ...payload, operationKey })");
    expect(purchases).toContain("returnToSupplier.mutateAsync({ ...payload, operationKey })");
    expect(purchases).not.toContain("getOrCreateOperationKey");
    expect(purchases).not.toContain("sessionStorage");
  });
});
