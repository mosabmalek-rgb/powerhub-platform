import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOfflineHrProjectionCacheForSite,
  isOfflineHrProjectionQueryKeyForSite,
  isOfflineFuelQueryKeyForSite,
  isOfflinePurchaseDetailQueryKeyForSite,
  isOfflineCacheableQueryKey,
  isDeltaSyncBackedQueryKey,
  isOfflineQueryRecordUsable,
  offlineQueryCacheKey,
  OFFLINE_DASHBOARD_SNAPSHOT_TTL_MS,
  OFFLINE_EXPENSE_FILTER_OPTIONS_TTL_MS,
  OFFLINE_SUPPLIER_FINANCIAL_SNAPSHOT_TTL_MS,
  persistOfflineQuery,
  persistOfflineQueryForDeltaSync,
  sanitizeOfflineQueryData,
} from "./offline-query-cache";
import { getOfflineQueryDeltaEntity, getOfflineQueryStaleTime, isOfflineDashboardSnapshotQueryKey, isOfflineDashboardRevisionQueryKey, isSafeSupplierLedgerStatementSnapshot, isSafeSupplierPayablesAgingSnapshot } from "./offline-query-policy";

describe("offline query cache policy", () => {
  it("caches tenant-scoped operational PowerHub queries", () => {
    expect(isOfflineCacheableQueryKey(["powerhub", "subscribers", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "readings", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "sites", "list"])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "generators", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub.tariffs.list", { input: { siteId: 7 }, type: "query" }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "schedules", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "subscribers", "list"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.list", { input: { siteId: 7, includeInactive: true }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.schedules.list", { input: { siteId: 0 }, type: "query" }])).toBe(false);
  });

  it("persists only safe inventory catalog lists and binds them to their Delta feeds", () => {
    const allowed = [
      ["powerhub.inventory.listItems", { input: { siteId: 7, search: undefined, includeInactive: false }, type: "query" }],
      ["powerhub.inventory.listSuppliers", { input: { siteId: 7, search: undefined, includeInactive: false }, type: "query" }],
      ["powerhub.inventory.listWarehouses", { input: { siteId: 7, includeInactive: false }, type: "query" }],
      ["powerhub.inventory.listItemUnits", { input: { siteId: 7, itemId: 12 }, type: "query" }],
    ] as const;
    for (const key of allowed) {
      expect(isOfflineCacheableQueryKey(key)).toBe(true);
      expect(isDeltaSyncBackedQueryKey(key)).toBe(true);
      expect(getOfflineQueryStaleTime(key)).toBe(Number.POSITIVE_INFINITY);
    }
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listItems", { input: { siteId: 7, search: "fuel", includeInactive: false }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listItems", { input: { siteId: 7, includeInactive: false }, type: "query" }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listSuppliers", { input: { siteId: 7, search: undefined, includeInactive: true }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listWarehouses", { input: { siteId: 0, includeInactive: false }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listItemUnits", { input: { siteId: 7, itemId: 0 }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listItemUnits", { input: { siteId: 7, itemId: 12, includeInactive: true }, type: "query" }])).toBe(false);
  });

  it("caches authorized supplier statements and complete aging reports as bounded read-only snapshots", () => {
    const ledgerKey = ["powerhub.inventory.supplierLedgerStatement", {
      input: { siteId: 7, supplierId: 11, limit: 200 }, type: "query",
    }] as const;
    const agingKey = ["powerhub.inventory.supplierPayablesAging", {
      input: { siteId: 7, asOfDate: "2026-10-30" }, type: "query",
    }] as const;
    expect(isSafeSupplierLedgerStatementSnapshot(ledgerKey)).toBe(true);
    expect(isSafeSupplierPayablesAgingSnapshot(agingKey)).toBe(true);
    for (const key of [ledgerKey, agingKey]) {
      expect(isOfflineCacheableQueryKey(key)).toBe(true);
      expect(isDeltaSyncBackedQueryKey(key)).toBe(false);
      expect(getOfflineQueryDeltaEntity(key)).toBeNull();
      expect(getOfflineQueryStaleTime(key)).toBe(30_000);
    }
    const badLedger = ["powerhub.inventory.supplierLedgerStatement", {
      input: { siteId: 7, supplierId: 11, limit: 200, includePayments: true }, type: "query",
    }] as const;
    expect(isSafeSupplierLedgerStatementSnapshot(badLedger)).toBe(false);

    const statement = sanitizeOfflineQueryData(ledgerKey, {
      supplier: { id: 11, name: "Supplier A", supplier_code: "SUP-A", phone: "PRIVATE" },
      site_id: 7, balance: "125.00", entry_count: 2,
      entries: [{
        id: 1, entry_type: "purchase", debit_amount: "100", credit_amount: "0",
        purchase_id: 8, supplier_payment_id: null, supplier_return_id: null,
        reference_no: "INV-8", description: "Invoice", entry_key: "PRIVATE-KEY",
        created_by_user_id: 9, occurred_at: "2026-10-30T10:00:00Z",
      }],
    }) as Record<string, any>;
    expect(statement.offlineSnapshot).toBe(true);
    expect(statement.balance).toBe("125.00");
    expect(statement.supplier).toEqual({ id: 11, name: "Supplier A", supplier_code: "SUP-A" });
    expect(statement.entries[0]).not.toHaveProperty("entry_key");
    expect(statement.entries[0]).not.toHaveProperty("created_by_user_id");

    const aging = sanitizeOfflineQueryData(agingKey, {
      as_of_date: "2026-10-30",
      totals: { not_due: "0", days_1_30: "10", days_31_60: "20", days_61_90: "30", days_91_plus: "40", total_outstanding: "100" },
      rows: [{
        document_type: "purchase_invoice", document_id: 8, supplier_id: 11, supplier_name: "Supplier A",
        document_number: "PO-8", document_date: "2026-10-01", due_date: "2026-10-15",
        gross_amount: "100", paid_amount: "20", credit_amount: "0", outstanding_amount: "80",
        days_overdue: 15, aging_bucket: "days_1_30", private_notes: "DO-NOT-CACHE",
      }],
    }) as Record<string, any>;
    expect(aging.offlineSnapshot).toBe(true);
    expect(aging.complete).toBe(true);
    expect(aging.totals.total_outstanding).toBe("100");
    expect(aging.rows[0].outstanding_amount).toBe("80");
    expect(aging.rows[0]).not.toHaveProperty("private_notes");
    expect(OFFLINE_SUPPLIER_FINANCIAL_SNAPSHOT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("persists exact purchase detail only as a sanitized non-Delta display snapshot", () => {
    const key = ["powerhub.inventory.getPurchase", {
      input: { siteId: 7, purchaseId: 33 }, type: "query",
    }] as const;
    const malformed = ["powerhub.inventory.getPurchase", {
      input: { siteId: 7, purchaseId: 33, withPayments: true }, type: "query",
    }] as const;
    expect(isOfflineCacheableQueryKey(key)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(key)).toBe(false);
    expect(getOfflineQueryDeltaEntity(key)).toBeNull();
    expect(getOfflineQueryStaleTime(key)).toBe(30_000);
    expect(isOfflineCacheableQueryKey(malformed)).toBe(false);

    const safe = sanitizeOfflineQueryData(key, {
      purchase: {
        id: 33, tenant_id: 2, site_id: 7, supplier_id: 11, warehouse_id: 5,
        purchase_number: "PO-33", supplier_invoice_no: "PRIVATE-INVOICE",
        invoice_date: "2026-10-28", due_date: "2026-11-28", status: "partially_received",
        subtotal_amount: "100", total_amount: "120", payment_terms_days: 30,
        reference_no: "PRIVATE-REFERENCE", notes: "PRIVATE-NOTE", operation_key: "PRIVATE-KEY",
        received_at: null, received_by_user_id: 9, confirmed_at: "2026-10-28T10:00:00Z",
        confirmed_by_user_id: 9, created_by_user_id: 9, created_at: "2026-10-28T10:00:00Z",
        updated_at: "2026-10-29T10:00:00Z", supplierName: "Supplier", supplierCode: "SUP-11",
        warehouseName: "Main", canViewFinancials: true, paidAmount: 50, outstandingAmount: 70,
      },
      canViewFinancials: true,
      lines: [{
        id: 1, purchase_id: 33, item_id: 8, quantity: "10.000", unit: "piece",
        units_to_base_factor: "1", unit_price: "12.00", discount_amount: "0",
        tax_amount: "0", line_subtotal: "120", line_total: "120", received_quantity: "5.000",
        notes: "PRIVATE-LINE-NOTE", itemName: "Filter", itemSku: "FLT-8", baseUnit: "piece",
      }],
      receipts: [{
        id: 2, receipt_number: "REC-2", receipt_date: "2026-10-29",
        operation_key: "PRIVATE-RECEIPT-KEY", notes: "PRIVATE-RECEIPT-NOTE",
        received_at: "2026-10-29T10:00:00Z", received_by_user_id: 9, created_at: "2026-10-29T10:00:00Z",
      }],
      returns: [{
        id: 3, return_number: "RET-3", return_date: "2026-10-29", status: "posted",
        reason: "PRIVATE-REASON", notes: "PRIVATE-RETURN-NOTE", total_credit_amount: "12",
        stock_cost_amount: "10", refund_amount: "5", refund_company_account_id: 15,
        returned_at: "2026-10-29T12:00:00Z", operation_key: "PRIVATE-RETURN-KEY",
        lines: [{
          id: 4, return_id: 3, purchase_line_id: 1, stock_movement_id: 8,
          quantity: "1", base_quantity: "1", supplier_credit_amount: "12",
          inventory_unit_cost: "10", stock_cost_amount: "10", itemName: "Filter", unit: "piece",
        }],
      }],
      payments: [{ id: 90, amount: 100, company_account_name: "Cash", reference_no: "PRIVATE" }],
    }) as Record<string, any>;

    expect(safe.offlineSnapshot).toBe(true);
    expect(safe.canViewFinancials).toBe(false);
    expect(safe.purchase).toMatchObject({ id: 33, purchase_number: "PO-33", supplierName: "Supplier", canViewFinancials: false });
    for (const field of ["supplier_invoice_no", "due_date", "total_amount", "payment_terms_days", "reference_no", "notes", "paidAmount", "outstandingAmount"]) {
      expect(safe.purchase[field]).toBeNull();
    }
    expect(safe.purchase).not.toHaveProperty("operation_key");
    expect(safe.lines[0]).toMatchObject({ itemName: "Filter", quantity: "10.000", received_quantity: "5.000" });
    for (const field of ["unit_price", "discount_amount", "tax_amount", "line_total", "notes"]) {
      expect(safe.lines[0]).not.toHaveProperty(field);
    }
    expect(safe.receipts[0]).toMatchObject({ receipt_number: "REC-2", notes: null });
    expect(safe.receipts[0]).not.toHaveProperty("operation_key");
    expect(safe.returns[0]).toMatchObject({ return_number: "RET-3", reason: null, notes: null, total_credit_amount: null });
    expect(safe.returns[0].lines[0]).toMatchObject({ itemName: "Filter", quantity: "1", purchase_line_id: 1 });
    for (const field of ["stock_movement_id", "supplier_credit_amount", "inventory_unit_cost", "stock_cost_amount"]) {
      expect(safe.returns[0].lines[0]).not.toHaveProperty(field);
    }
    expect(safe.payments).toEqual([]);
  });

  it("matches purchase detail cache cleanup to the denied user/site/purchase only", () => {
    const exact = ["powerhub.inventory.getPurchase", { input: { siteId: 7, purchaseId: 33 }, type: "query" }] as const;
    const otherPurchase = ["powerhub.inventory.getPurchase", { input: { siteId: 7, purchaseId: 34 }, type: "query" }] as const;
    const otherSite = ["powerhub.inventory.getPurchase", { input: { siteId: 8, purchaseId: 33 }, type: "query" }] as const;
    const anotherProcedure = ["powerhub.inventory.supplierLedgerStatement", { input: { siteId: 7, supplierId: 11 }, type: "query" }] as const;
    expect(isOfflinePurchaseDetailQueryKeyForSite(exact, 7, 33)).toBe(true);
    expect(isOfflinePurchaseDetailQueryKeyForSite(otherPurchase, 7, 33)).toBe(false);
    expect(isOfflinePurchaseDetailQueryKeyForSite(otherSite, 7)).toBe(false);
    expect(isOfflinePurchaseDetailQueryKeyForSite(anotherProcedure, 7)).toBe(false);
  });

  it("caches minimized fuel workspace dropdowns without treating them as a Delta feed", () => {
    const key = ["powerhub.inventory.fuelWorkspaceOptions", { input: { siteId: 7 }, type: "query" }];
    expect(isOfflineCacheableQueryKey(key)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(key)).toBe(false);
    expect(getOfflineQueryDeltaEntity(key)).toBeNull();
    expect(getOfflineQueryStaleTime(key)).toBe(30_000);
    const safe = sanitizeOfflineQueryData(key, {
      generators: [{ id: 4, code: "G-1", name: "مولد", fuelType: "diesel", fuelLevelLiters: 15, operatingHours: 30, status: "active", unit_cost: 77 }],
      generatorTanks: [{ id: 8, code: "T-1", name: "خزان", generatorId: 4, quantity_on_hand: 999 }],
      fuelItems: [{ id: 9, sku: "DIESEL", name: "ديزل", baseUnit: "liter", avg_cost: 42 }],
      sourceLocations: [{ id: 10, code: "WH-1", name: "مستودع", locationType: "central_warehouse", stock_balance: 1000 }],
      canManageFuel: true, canViewFuelReports: true,
    }) as Record<string, Array<Record<string, unknown>>>;
    expect(safe.generators[0]).toMatchObject({ id: 4, name: "مولد", fuelLevelLiters: 15 });
    expect(safe.generators[0]).not.toHaveProperty("unit_cost");
    expect(safe.generatorTanks[0]).not.toHaveProperty("quantity_on_hand");
    expect(safe.fuelItems[0]).not.toHaveProperty("avg_cost");
    expect(safe.sourceLocations[0]).not.toHaveProperty("stock_balance");
    expect(safe).not.toHaveProperty("canManageFuel");
    expect(safe).not.toHaveProperty("canViewFuelReports");
  });

  it("enables only complete site-wide fuel-reading and preventive-plan lists backed by explicit Delta feeds", () => {
    const fuelReadings = ["powerhub.inventory.listFuelReadings", {
      input: { siteId: 7, generatorId: undefined, limit: 100 }, type: "query",
    }];
    const filteredFuelReadings = ["powerhub.inventory.listFuelReadings", {
      input: { siteId: 7, generatorId: 21, limit: 100 }, type: "query",
    }];
    const plans = ["powerhub.maintenance.listPreventivePlans", {
      input: { siteId: 7 }, type: "query",
    }];
    for (const key of [fuelReadings, plans]) {
      expect(isOfflineCacheableQueryKey(key)).toBe(true);
      expect(isDeltaSyncBackedQueryKey(key)).toBe(true);
      expect(getOfflineQueryStaleTime(key)).toBe(Number.POSITIVE_INFINITY);
      expect(getOfflineQueryDeltaEntity(key)).toBe(
        key === plans ? "maintenance_preventive_plans" : "fuel_readings",
      );
    }
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listFuelReadings", {
      input: { siteId: 7, limit: 99 }, type: "query",
    }])).toBe(false);
    // Filtered readings are exact server snapshots, not direct Delta projections.
    expect(isOfflineCacheableQueryKey(filteredFuelReadings)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(filteredFuelReadings)).toBe(false);
    expect(getOfflineQueryDeltaEntity(filteredFuelReadings)).toBeNull();
    expect(getOfflineQueryStaleTime(filteredFuelReadings)).toBe(30_000);
    expect(isOfflineCacheableQueryKey(["powerhub.maintenance.listPreventivePlans", {
      input: { siteId: 7, generatorId: 21 }, type: "query",
    }])).toBe(false);
    const fuelEvents = ["powerhub.inventory.listFuelEvents", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }];
    const filteredFuelEvents = ["powerhub.inventory.listFuelEvents", {
      input: { siteId: 7, fromDate: "2026-10-01", toDate: "2026-10-29", limit: 100 }, type: "query",
    }];
    const workOrders = ["powerhub.maintenance.listWorkOrders", {
      input: { siteId: 7, limit: 200 }, type: "query",
    }];
    const filteredWorkOrders = ["powerhub.maintenance.listWorkOrders", {
      input: { siteId: 7, status: "in_progress", limit: 200 }, type: "query",
    }];
    const parts = ["powerhub.maintenance.listParts", {
      input: { siteId: 7, workOrderId: 9001 }, type: "query",
    }];
    for (const [key, entity] of [
      [fuelEvents, "fuel_events"],
      [workOrders, "maintenance_work_orders"],
      [parts, "maintenance_work_order_parts:9001"],
    ] as const) {
      expect(isOfflineCacheableQueryKey(key)).toBe(true);
      expect(isDeltaSyncBackedQueryKey(key)).toBe(true);
      expect(getOfflineQueryDeltaEntity(key)).toBe(entity);
      expect(getOfflineQueryStaleTime(key)).toBe(Number.POSITIVE_INFINITY);
    }
    expect(isOfflineCacheableQueryKey(filteredFuelEvents)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(filteredFuelEvents)).toBe(false);
    expect(getOfflineQueryDeltaEntity(filteredFuelEvents)).toBeNull();
    expect(getOfflineQueryStaleTime(filteredFuelEvents)).toBe(30_000);
    expect(isOfflineCacheableQueryKey(filteredWorkOrders)).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.maintenance.listParts", {
      input: { siteId: 7, workOrderId: 0 }, type: "query",
    }])).toBe(false);
  });

  it("accepts only valid exact-filter fuel snapshots and removes sensitive fields", () => {
    const filteredReadings = ["powerhub.inventory.listFuelReadings", {
      input: { siteId: 7, generatorId: 21, limit: 100 }, type: "query",
    }] as const;
    const invalidReadingType = ["powerhub.inventory.listFuelReadings", {
      input: { siteId: 7, generatorId: 21, readingType: "secret", limit: 100 }, type: "query",
    }] as const;
    const invalidReadLimit = ["powerhub.inventory.listFuelReadings", {
      input: { siteId: 7, generatorId: 21, limit: 500 }, type: "query",
    }] as const;
    const filteredEvents = ["powerhub.inventory.listFuelEvents", {
      input: { siteId: 7, fromDate: "2026-10-01", toDate: "2026-10-29", generatorId: 21, limit: 100 }, type: "query",
    }] as const;
    const invalidEvents = ["powerhub.inventory.listFuelEvents", {
      input: { siteId: 7, fromDate: "2026-10-30", toDate: "2026-10-01", limit: 100 }, type: "query",
    }] as const;

    expect(isOfflineCacheableQueryKey(filteredReadings)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(filteredReadings)).toBe(false);
    expect(isOfflineCacheableQueryKey(filteredEvents)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(filteredEvents)).toBe(false);
    expect(isOfflineCacheableQueryKey(invalidReadingType)).toBe(false);
    expect(isOfflineCacheableQueryKey(invalidReadLimit)).toBe(false);
    expect(isOfflineCacheableQueryKey(invalidEvents)).toBe(false);

    const safeEvents = sanitizeOfflineQueryData(filteredEvents, [{
      id: 4, event_id: 4, tenant_id: 2, site_id: 7, generator_id: 21, generator_name: "G-21",
      fuel_item_name: "Diesel", source_warehouse_id: 2, source_warehouse_name: "Main",
      destination_warehouse_id: 3, destination_warehouse_name: "Tank", litres: "20.000",
      occurred_at: "2026-10-21T12:00:00Z", level_before_liters: "10.000",
      level_after_liters: "30.000", operating_hours: "120.00", reference_no: "F-4",
      notes: "private", unit_cost: "5.00", total_cost_amount: "100.00", created_by_user_id: 99,
    }]) as Array<Record<string, unknown>>;
    expect(safeEvents[0]).toMatchObject({ id: 4, event_id: 4, site_id: 7, generator_id: 21, litres: "20.000" });
    expect(safeEvents[0]).not.toHaveProperty("notes");
    expect(safeEvents[0]).not.toHaveProperty("unit_cost");
    expect(safeEvents[0]).not.toHaveProperty("total_cost_amount");
    expect(safeEvents[0]).not.toHaveProperty("created_by_user_id");

    const safeReadings = sanitizeOfflineQueryData(filteredReadings, [{
      id: 5, reading_id: 5, tenant_id: 2, site_id: 7, generator_id: 21, generator_name: "G-21",
      reading_type: "tank_level", tank_warehouse_id: 30, tank_name: "Tank",
      reading_value: "33.000", recorded_at: "2026-10-21T12:00:00Z", reference_no: "R-5",
      corrects_reading_id: null, notes: "private", correction_reason: "private", created_by_user_id: 99,
    }]) as Array<Record<string, unknown>>;
    expect(safeReadings[0]).toMatchObject({ id: 5, reading_id: 5, site_id: 7, generator_id: 21, reading_type: "tank_level" });
    expect(safeReadings[0]).not.toHaveProperty("notes");
    expect(safeReadings[0]).not.toHaveProperty("correction_reason");
    expect(safeReadings[0]).not.toHaveProperty("created_by_user_id");
  });

  it("matches exact fuel cache purges to the requested user/site procedures", () => {
    const eventKey = ["powerhub.inventory.listFuelEvents", {
      input: { siteId: 7, fromDate: "2026-10-01", toDate: "2026-10-29", limit: 100 }, type: "query",
    }] as const;
    const readingKey = ["powerhub.inventory.listFuelReadings", {
      input: { siteId: 7, generatorId: 21, limit: 100 }, type: "query",
    }] as const;
    const otherSiteKey = ["powerhub.inventory.listFuelEvents", {
      input: { siteId: 8, limit: 100 }, type: "query",
    }] as const;
    expect(isOfflineFuelQueryKeyForSite(eventKey, 7)).toBe(true);
    expect(isOfflineFuelQueryKeyForSite(readingKey, 7)).toBe(true);
    expect(isOfflineFuelQueryKeyForSite(otherSiteKey, 7)).toBe(false);
    expect(isOfflineFuelQueryKeyForSite(eventKey, 7, ["listFuelReadings"])).toBe(false);
  });

  it("caps fuel and maintenance query data during cache save and hydration", async () => {
    const { sanitizeOfflineQueryData } = await import("./offline-query-cache");
    const fuelKey = ["powerhub.inventory.listFuelReadings", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }];
    const fuelRows = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      reading_id: index + 1,
      recorded_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
    }));
    const safeFuel = sanitizeOfflineQueryData(fuelKey, fuelRows) as Array<{ id: number }>;
    expect(safeFuel).toHaveLength(100);
    expect(safeFuel[0]?.id).toBe(501);
    expect(safeFuel.at(-1)?.id).toBe(402);

    const plansKey = ["powerhub.maintenance.listPreventivePlans", {
      input: { siteId: 7 }, type: "query",
    }];
    const plans = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1,
      plan_id: index + 1,
      alert_type: index === 0 ? "overdue" : "normal",
      next_due_at: new Date(Date.UTC(2027, 0, 1 + index)).toISOString(),
    }));
    const safePlans = sanitizeOfflineQueryData(plansKey, plans) as Array<{ id: number }>;
    expect(safePlans).toHaveLength(500);
    expect(safePlans[0]?.id).toBe(1);
    expect(safePlans.some(row => row.id === 501)).toBe(false);
  });

  it("caps recent fuel-event and work-order cache snapshots without truncating a per-order parts list", async () => {
    const { sanitizeOfflineQueryData } = await import("./offline-query-cache");
    const eventsKey = ["powerhub.inventory.listFuelEvents", { input: { siteId: 7, limit: 100 }, type: "query" }];
    const events = Array.from({ length: 501 }, (_, index) => ({
      id: index + 1, event_id: index + 1,
      occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
    }));
    const safeEvents = sanitizeOfflineQueryData(eventsKey, events) as Array<{ id: number }>;
    expect(safeEvents).toHaveLength(100);
    expect(safeEvents[0]?.id).toBe(501);
    expect(safeEvents[0]).not.toHaveProperty("unit_cost");
    expect(safeEvents[0]).not.toHaveProperty("total_cost_amount");
    expect(safeEvents[0]).toHaveProperty("notes", null);
    expect(safeEvents[0]).toHaveProperty("created_by_user_id", null);

    const ordersKey = ["powerhub.maintenance.listWorkOrders", { input: { siteId: 7, limit: 200 }, type: "query" }];
    const orders = Array.from({ length: 201 }, (_, index) => ({
      id: index + 1, work_order_id: index + 1,
      reported_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
    }));
    const safeOrders = sanitizeOfflineQueryData(ordersKey, orders) as Array<{ id: number }>;
    expect(safeOrders).toHaveLength(200);
    expect(safeOrders[0]?.id).toBe(201);

    const partsKey = ["powerhub.maintenance.listParts", { input: { siteId: 7, workOrderId: 9001 }, type: "query" }];
    const parts = Array.from({ length: 501 }, (_, index) => ({ id: index + 1, part_id: index + 1, work_order_id: 9001 }));
    const safeParts = sanitizeOfflineQueryData(partsKey, parts) as Array<Record<string, unknown>>;
    expect(safeParts).toHaveLength(501);
    expect(safeParts[0]).toHaveProperty("notes", null);
  });

  it("persists only safe dashboard aggregate snapshots and never treats them as Delta-backed lists", () => {
    const summary = ["powerhub", "dashboard", "summary", { siteId: 7 }];
    const financial = ["powerhub.dashboard.financialOverview", {
      input: { siteId: 7, scope: "branch", includeDetails: false }, type: "query",
    }];
    const period = ["powerhub.dashboard.periodMetrics", {
      input: { siteId: 7, scope: "branch", startDate: "2026-10-01", endDate: "2026-10-29", includeDetails: false }, type: "query",
    }];
    const activeSubscribers = ["powerhub.dashboard.activeSubscribersKpi", {
      input: { siteId: 7, scope: "branch" }, type: "query",
    }];
    const independentPeriod = ["powerhub.dashboard.periodKpi", {
      input: { siteId: 7, scope: "branch", metric: "periodInvoiced", startDate: "2026-10-01", endDate: "2026-10-29" }, type: "query",
    }];
    const invalidIndependentPeriod = ["powerhub.dashboard.periodKpi", {
      input: { siteId: 7, scope: "branch", metric: "privateDetails", startDate: "2026-10-01", endDate: "2026-10-29" }, type: "query",
    }];
    const revision = ["powerhub.dashboard.deltaRevision", { input: { siteId: 7, scope: "branch" }, type: "query" }];

    for (const key of [summary, financial, period, activeSubscribers, independentPeriod]) {
      expect(isOfflineCacheableQueryKey(key)).toBe(true);
      expect(isOfflineDashboardSnapshotQueryKey(key)).toBe(true);
      expect(isDeltaSyncBackedQueryKey(key)).toBe(false);
    }
    expect(isOfflineCacheableQueryKey(invalidIndependentPeriod)).toBe(false);
    expect(isOfflineCacheableQueryKey(revision)).toBe(true);
    expect(isOfflineDashboardRevisionQueryKey(revision)).toBe(true);
    expect(isOfflineDashboardSnapshotQueryKey(revision)).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.dashboard.financialOverview", {
      input: { siteId: 7, scope: "branch", includeDetails: true }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.dashboard.periodMetrics", {
      input: { siteId: 7, scope: "branch", startDate: "2026-10-29", endDate: "2026-10-01", includeDetails: false }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "payments", "list", { siteId: 7 }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "admin", "tenants"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["auth", "me"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "audit", "list", { siteId: 7 }])).toBe(false);
    expect(OFFLINE_DASHBOARD_SNAPSHOT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("persists bounded history pages and maps supported pages to their Delta feeds", () => {
    const readingPage = ["powerhub.readings.page", {
      input: { siteId: 7, limit: 200 }, type: "query",
    }];
    const invoicePage = ["powerhub.invoices.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }];
    const paymentPage = ["powerhub.payments.page", {
      input: { siteId: 7, limit: 100, cursor: "next-page-token" }, type: "query",
    }];
    const expensePage = ["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, startDate: "2026-10-01", endDate: "2026-10-27", companyAccountId: 12 },
      type: "query",
    }];

    for (const key of [readingPage, invoicePage, paymentPage, expensePage]) {
      expect(isOfflineCacheableQueryKey(key)).toBe(true);
    }

    // Every page marked Delta-backed here has a corresponding scoped server feed and runtime projection.
    expect(isDeltaSyncBackedQueryKey(readingPage)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(invoicePage)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(paymentPage)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(expensePage)).toBe(true);
    expect(getOfflineQueryDeltaEntity(expensePage)).toBe("expenses");
    expect(getOfflineQueryStaleTime(paymentPage)).toBe(Number.POSITIVE_INFINITY);

    expect(isOfflineCacheableQueryKey(["powerhub.readings.page", {
      input: { siteId: 0, limit: 100 }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.invoices.page", {
      input: { siteId: 7, limit: 201 }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.payments.page", {
      input: { siteId: 7, limit: 100, includeOtherSites: true }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, cursor: "next-page-token" }, type: "query",
    }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, cursor: "next-page-token" }, type: "query",
    }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, cursor: "" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, cursor: "x".repeat(501) }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, startDate: "2026-10-28" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.payments.list", {
      input: { siteId: 7 }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, companyAccountId: 0 }, type: "query",
    }])).toBe(false);
  });

  it("persists bounded subscriber directory pages with search and type filters for a valid site", () => {
    const pageOne = ["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 20, search: "" },
      type: "query",
    }];
    const pageTwo = ["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 2, pageSize: 20, search: "" },
      type: "query",
    }];

    expect(isOfflineCacheableQueryKey(pageOne)).toBe(true);
    expect(isOfflineCacheableQueryKey(pageTwo)).toBe(true);
    expect(isOfflineCacheableQueryKey([["powerhub", "subscribers", "directoryPage"], {
      input: { siteId: 7, page: 1, pageSize: 20, search: "" }, type: "query",
    }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 20, search: "أحمد" }, type: "query",
    }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 20, search: "", subscriptionType: "commercial" }, type: "query",
    }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 200, search: "" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 0, pageSize: 20, search: "" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 0, page: 1, pageSize: 20, search: "" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 20, search: "", includeFinancial: true }, type: "query",
    }])).toBe(false);
  });

  it("rejects unrelated namespaces and similarly named nested data", () => {
    expect(isOfflineCacheableQueryKey(["users", "list"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["settings", "get"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "subscriberQuota", "get", { label: "subscribers" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "subscribers", "getById", { siteId: 7, id: 12 }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", { input: { siteId: 7 }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey([["powerhub", "subscribers", "list"], { input: { siteId: 7 } }])).toBe(true);
    expect(isOfflineCacheableQueryKey([["powerhub", "payments", "list"], { input: { siteId: 7 } }])).toBe(false);
  });

  it("keeps site-scoped query keys distinct after serialization", () => {
    const site7 = ["powerhub", "subscribers", "list", { siteId: 7 }];
    const site8 = ["powerhub", "subscribers", "list", { siteId: 8 }];
    expect(offlineQueryCacheKey(site7)).not.toBe(offlineQueryCacheKey(site8));
  });

  it("accepts only current-user, unexpired, cacheable records", () => {
    const key = ["powerhub", "subscribers", "list", { siteId: 7 }];
    const baseRecord = {
      userId: "user-1",
      serializedQueryKey: offlineQueryCacheKey(key),
      expiresAt: 2_000,
    };

    expect(isOfflineQueryRecordUsable(baseRecord, "user-1", 1_000)).toBe(true);
    expect(isOfflineQueryRecordUsable(baseRecord, "user-2", 1_000)).toBe(false);
    expect(isOfflineQueryRecordUsable(baseRecord, "user-1", 2_000)).toBe(false);
    expect(
      isOfflineQueryRecordUsable(
        { ...baseRecord, serializedQueryKey: offlineQueryCacheKey(["powerhub", "payments", "list"]) },
        "user-1",
        1_000,
      ),
    ).toBe(false);
  });

  it("retains allowed operational snapshots across days when no explicit expiry is set", () => {
    const key = ["powerhub", "subscribers", "list", { siteId: 7 }];
    const persistentRecord = {
      userId: "user-1",
      serializedQueryKey: offlineQueryCacheKey(key),
      expiresAt: null,
    };

    expect(isOfflineQueryRecordUsable(persistentRecord, "user-1", Date.parse("2030-01-01T00:00:00.000Z"))).toBe(true);
    expect(isOfflineQueryRecordUsable({ ...persistentRecord, expiresAt: 2_000 }, "user-1", 2_000)).toBe(false);
  });

  it("rejects malformed serialized query keys", () => {
    expect(
      isOfflineQueryRecordUsable(
        {
          userId: "user-1",
          serializedQueryKey: "not-valid-superjson",
          expiresAt: 2_000,
        },
        "user-1",
        1_000,
      ),
    ).toBe(false);
  });
});


describe("offline cache privacy sanitization", () => {
  it("strips current and legacy receipt URLs, private keys, and hashes before persistence/hydration", () => {
    const queryKey = ["powerhub.payments.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }];
    const raw = {
      items: [{
        payment: {
          id: 4, hasReceiptImage: false,
          receiptImageUrl: "https://signed.example/temporary?token=secret",
          receiptImageKey: "private/payment-receipts/4.png",
          receiptImageHash: "private-hash",
          receipt_image_url: "https://signed.example/legacy?token=legacy",
          receipt_image_key: "private/legacy.png",
          receipt_image_hash: "legacy-hash",
        },
        subscriber: { id: 9, fullName: "Subscriber" },
      }],
      hasNext: false, nextCursor: null,
    };
    const safe = sanitizeOfflineQueryData(queryKey, raw) as typeof raw;
    expect(safe.items[0].payment.hasReceiptImage).toBe(true);
    for (const key of [
      "receiptImageUrl", "receiptImageKey", "receiptImageHash",
      "receipt_image_url", "receipt_image_key", "receipt_image_hash",
    ]) expect(safe.items[0].payment).not.toHaveProperty(key);
    expect(safe.items[0].subscriber.fullName).toBe("Subscriber");
  });

  it("removes debtor and invoice detail from dashboard snapshots before local persistence", () => {
    const financialKey = ["powerhub.dashboard.financialOverview", {
      input: { siteId: 7, scope: "branch", includeDetails: false }, type: "query",
    }];
    const financial = {
      month: { collected: 12 },
      topDebtors: [{ subscriber: "Private name", outstanding: 99 }],
      outstandingInvoices: [{ invoiceId: 4, subscriber: "Private name" }],
    };
    expect(sanitizeOfflineQueryData(financialKey, financial)).toEqual({
      month: { collected: 12 }, topDebtors: [], outstandingInvoices: [],
    });

    const periodKey = ["powerhub.dashboard.periodMetrics", {
      input: { siteId: 7, scope: "branch", startDate: "2026-10-01", endDate: "2026-10-29", includeDetails: false }, type: "query",
    }];
    expect(sanitizeOfflineQueryData(periodKey, {
      summary: { collected: 12 }, outstandingInvoices: [{ subscriber: "Private name" }],
    })).toEqual({ summary: { collected: 12 }, outstandingInvoices: [] });

    const periodKpiKey = ["powerhub.dashboard.periodKpi", {
      input: { siteId: 7, scope: "branch", metric: "periodOverdue", startDate: "2026-10-01", endDate: "2026-10-29" }, type: "query",
    }];
    expect(sanitizeOfflineQueryData(periodKpiKey, {
      metric: "periodOverdue", value: 55, auxiliaryCount: 4,
      range: { startDate: "2026-10-01", endDate: "2026-10-29" },
      scope: "branch", siteId: 7,
      privateInvoiceRows: [{ subscriber: "Private name" }],
    })).toEqual({
      metric: "periodOverdue", value: 55, auxiliaryCount: 4,
      range: { startDate: "2026-10-01", endDate: "2026-10-29" },
      scope: "branch", siteId: 7,
    });
    const activeSubscribersKey = ["powerhub.dashboard.activeSubscribersKpi", {
      input: { siteId: 7, scope: "branch" }, type: "query",
    }];
    expect(sanitizeOfflineQueryData(activeSubscribersKey, {
      metric: "activeSubscribers", value: 25, scope: "branch", siteId: 7,
      privateRows: [{ subscriber: "Private name" }],
    })).toEqual({ metric: "activeSubscribers", value: 25, scope: "branch", siteId: 7 });
  });

  it("does not invent HR optimistic-lock versions for legacy snapshots", () => {
    const employeeKey = ["powerhub.hr.offlineDirectory", {
      input: { siteId: 7 }, type: "query",
    }];
    const employeeRows = sanitizeOfflineQueryData(employeeKey, [{
      id: 42, tenantId: 1, siteId: 7, fullName: "موظف",
    }]) as Array<Record<string, unknown>>;
    expect(employeeRows[0].versionNo).toBe(0);

    const attendanceKey = ["powerhub.hr.offlineAttendance", {
      input: { siteId: 7 }, type: "query",
    }];
    const attendanceRows = sanitizeOfflineQueryData(attendanceKey, [{
      id: 81, tenantId: 1, siteId: 7,
      attendance: { id: 81, tenantId: 1, employeeId: 42, siteId: 7, workDate: "2026-10-28" },
      employee: { id: 42, tenantId: 1, siteId: 7, fullName: "موظف" },
    }]) as Array<Record<string, any>>;
    expect(attendanceRows[0].attendance.versionNo).toBe(0);
  });

  it("does not alter unrelated query payloads", () => {
    const data = { items: [{ receipt_image_url: "preserve-other-domain" }] };
    expect(sanitizeOfflineQueryData(["powerhub.subscribers.list", { siteId: 7 }], data)).toEqual(data);
  });
});

describe("offline query freshness policy", () => {
  it("prevents full-query refetches for Delta-backed snapshots after reload", () => {
    expect(getOfflineQueryStaleTime(["powerhub", "sites", "list"])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub", "subscribers", "list", { siteId: 7 }])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub.invoices.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps Delta-backed pages fresh while unsupported lists retain bounded freshness", () => {
    expect(getOfflineQueryStaleTime(["powerhub.readings.page", {
      input: { siteId: 7, limit: 200 }, type: "query",
    }])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub.payments.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub.schedules.list", {
      input: { siteId: 7 }, type: "query",
    }])).toBe(30_000);
  });
});

describe("Delta-backed local snapshots", () => {
  it("only marks supported whole-list procedures as Delta-backed", () => {
    expect(isDeltaSyncBackedQueryKey(["powerhub", "sites", "list"])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "subscribers", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7, branchId: 7 }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7, branchId: 7 }])).toBe(true);
    expect(getOfflineQueryDeltaEntity(["powerhub", "companyAccounts", "list", { siteId: 7, branchId: 7 }])).toBe("company_accounts");
    expect(getOfflineQueryDeltaEntity(["powerhub.companyAccounts.list", {
      input: { siteId: 7, branchId: 8 }, type: "query",
    }])).toBe("company_accounts");
    expect(getOfflineQueryDeltaEntity(["powerhub.inventory.listItems", { input: { siteId: 7 }, type: "query" }])).toBe("inventory_items");
    expect(getOfflineQueryDeltaEntity(["powerhub.inventory.listItemUnits", { input: { siteId: 7, itemId: 12 }, type: "query" }])).toBe("inventory_item_units");
    expect(getOfflineQueryDeltaEntity(["powerhub.inventory.listSuppliers", { input: { siteId: 7 }, type: "query" }])).toBe("suppliers");
    expect(getOfflineQueryDeltaEntity(["powerhub.inventory.listWarehouses", { input: { siteId: 7 }, type: "query" }])).toBe("inventory_warehouses");
    const stocktakeKey = ["powerhub.inventory.listStocktakes", { input: { siteId: 7, warehouseId: undefined, limit: 100 }, type: "query" }] as const;
    expect(isOfflineCacheableQueryKey(stocktakeKey)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(stocktakeKey)).toBe(true);
    expect(getOfflineQueryDeltaEntity(stocktakeKey)).toBe("inventory_stocktakes");
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listStocktakes", { input: { siteId: 7, warehouseId: 9, limit: 100 }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listStocktakes", { input: { siteId: 7, warehouseId: undefined, limit: 50 }, type: "query" }])).toBe(false);
    const purchaseHeadersKey = ["powerhub.inventory.listPurchaseHeaders", { input: { siteId: 7, limit: 100 }, type: "query" }] as const;
    expect(isOfflineCacheableQueryKey(purchaseHeadersKey)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(purchaseHeadersKey)).toBe(true);
    expect(getOfflineQueryDeltaEntity(purchaseHeadersKey)).toBe("inventory_purchase_headers");
    const receiptHeadersKey = ["powerhub.inventory.listPurchaseReceiptHeaders", { input: { siteId: 7, limit: 100 }, type: "query" }] as const;
    const supplierReturnHeadersKey = ["powerhub.inventory.listSupplierReturnHeaders", { input: { siteId: 7, limit: 100 }, type: "query" }] as const;
    expect(isOfflineCacheableQueryKey(receiptHeadersKey)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(receiptHeadersKey)).toBe(true);
    expect(getOfflineQueryDeltaEntity(receiptHeadersKey)).toBe("inventory_purchase_receipt_headers");
    expect(isOfflineCacheableQueryKey(supplierReturnHeadersKey)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(supplierReturnHeadersKey)).toBe(true);
    expect(getOfflineQueryDeltaEntity(supplierReturnHeadersKey)).toBe("inventory_supplier_return_headers");
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listPurchaseReceiptHeaders", { input: { siteId: 7, limit: 200 }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listSupplierReturnHeaders", { input: { siteId: 7, limit: 100, search: "secret" }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listPurchaseHeaders", { input: { siteId: 7, limit: 200 }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listPurchaseHeaders", { input: { siteId: 7, limit: 100, search: "wire" }, type: "query" }])).toBe(false);
    const movementKey = ["powerhub.inventory.listStockMovements", { input: { siteId: 7, limit: 100 }, type: "query" }] as const;
    expect(isOfflineCacheableQueryKey(movementKey)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(movementKey)).toBe(true);
    expect(getOfflineQueryDeltaEntity(movementKey)).toBe("inventory_stock_movements");
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listStockMovements", { input: { siteId: 7, limit: 500 }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.inventory.listStockMovements", { input: { siteId: 7, limit: 100, includeCosts: true }, type: "query" }])).toBe(false);
    expect(getOfflineQueryDeltaEntity(["powerhub", "companyAccounts", "list", { siteId: 7 }])).toBe(null);
    expect(isOfflineCacheableQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7 }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7, fromDate: "2026-10-01" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7, branchId: 7, toDate: "2026-10-27" }])).toBe(false);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "readings", "list", { siteId: 7 }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.tariffs.list", { input: { siteId: 7 }, type: "query" }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.invoices.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.payments.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "schedules", "list", { siteId: 7 }])).toBe(false);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "payments", "list", { siteId: 7 }])).toBe(false);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "subscribers", "getById", { siteId: 7, id: 1 }])).toBe(false);
  });

  it("keeps unsupported fuel event/report, maintenance work-order/report, HR and financial procedures out of generic persistent cache", () => {
    const unsupportedKeys = [
      ["powerhub.inventory.fuelConsumptionReportPeriod", {
        input: { siteId: 7, periodType: "month", anchorDate: "2026-10-01" }, type: "query",
      }],
      ["powerhub.maintenance.reportByGenerator", {
        input: { siteId: 7, fromDate: "2026-10-01", toDate: "2026-10-29" }, type: "query",
      }],
      ["powerhub.maintenance.listWorkOrders", {
        input: { siteId: 7, limit: 100 }, type: "query",
      }],
      ["powerhub.hr.listEmployees", {
        input: { siteId: 7, employmentStatus: "active" }, type: "query",
      }],
      ["powerhub.hr.listAttendance", {
        input: { siteId: 7, fromDate: "2026-10-01", toDate: "2026-10-29" }, type: "query",
      }],
      ["powerhub.hr.listPayrollRuns", { input: { siteId: 7 }, type: "query" }],
      ["powerhub.hr.getPayrollDetails", {
        input: { siteId: 7, payrollRunId: 3 }, type: "query",
      }],
      ["powerhub.reports.range", {
        input: { siteId: 7, startDate: "2026-10-01", endDate: "2026-10-29" }, type: "query",
      }],
      ["powerhub.reports.allBranchesRange", {
        input: { siteId: 7, startDate: "2026-10-01", endDate: "2026-10-29" }, type: "query",
      }],
    ] as const;

    for (const key of unsupportedKeys) {
      expect(isOfflineCacheableQueryKey(key)).toBe(false);
      expect(isDeltaSyncBackedQueryKey(key)).toBe(false);
      expect(getOfflineQueryDeltaEntity(key)).toBeNull();
      expect(getOfflineQueryStaleTime(key)).toBe(30_000);
    }

    const filteredFuelEvents = ["powerhub.inventory.listFuelEvents", {
      input: { siteId: 7, fromDate: "2026-10-01", toDate: "2026-10-29", limit: 100 }, type: "query",
    }] as const;
    // This is a bounded, exact-filter snapshot, not a direct site-wide Delta projection.
    expect(isOfflineCacheableQueryKey(filteredFuelEvents)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(filteredFuelEvents)).toBe(false);
    expect(getOfflineQueryDeltaEntity(filteredFuelEvents)).toBeNull();
    expect(getOfflineQueryStaleTime(filteredFuelEvents)).toBe(30_000);

    // Generator snapshots have a defined Delta contract, and fuel readings have
    // their own bounded feed; neither replaces fuel-event, consumption-report, or maintenance-history feeds.
    const generators = ["powerhub.generators.list", { input: { siteId: 7 }, type: "query" }] as const;
    expect(isOfflineCacheableQueryKey(generators)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(generators)).toBe(true);
    expect(getOfflineQueryDeltaEntity(generators)).toBe("generators");
  });
});


describe("offline query cache persistence failure policy", () => {
  let transactionOutcome: "commit" | "abort" = "commit";
  let putCount = 0;

  afterEach(() => {
    vi.unstubAllGlobals();
    transactionOutcome = "commit";
    putCount = 0;
  });

  function installIndexedDbMock() {
    const database = {
      objectStoreNames: { contains: (_name: string) => false },
      createObjectStore: vi.fn(),
      close: vi.fn(),
      transaction: vi.fn((_storeName: string, _mode: IDBTransactionMode) => {
        const transaction: Record<string, unknown> = {
          objectStore: () => ({
            put: vi.fn(() => {
              putCount += 1;
              const request: Record<string, unknown> = {};
              queueMicrotask(() => {
                (request.onsuccess as (() => void) | undefined)?.();
                // Simulate the subtle IndexedDB case where the request succeeds,
                // but the enclosing transaction later aborts.
                queueMicrotask(() => {
                  if (transactionOutcome === "commit") {
                    (transaction.oncomplete as (() => void) | undefined)?.();
                  } else {
                    (transaction.onabort as (() => void) | undefined)?.();
                  }
                });
              });
              return request;
            }),
          }),
        };
        return transaction;
      }),
    };

    const indexedDb = {
      open: vi.fn(() => {
        const request: Record<string, unknown> = { result: database };
        queueMicrotask(() => {
          (request.onupgradeneeded as (() => void) | undefined)?.();
          (request.onsuccess as (() => void) | undefined)?.();
        });
        return request;
      }),
    };
    vi.stubGlobal("indexedDB", indexedDb as unknown as IDBFactory);
  }

  const successfulQuery = {
    queryKey: ["powerhub", "subscribers", "list", { siteId: 7 }],
    state: {
      status: "success",
      data: [{ id: 11, tenantId: 1, siteId: 7, name: "Subscriber" }],
      dataUpdatedAt: 1_000,
    },
  };

  it("keeps ordinary query-cache persistence best-effort after an IndexedDB transaction abort", async () => {
    installIndexedDbMock();
    transactionOutcome = "abort";

    await expect(persistOfflineQuery(successfulQuery as never, "user-1", 1_000)).resolves.toBeUndefined();
    expect(putCount).toBe(1);
  });

  it("requires the transaction to commit before treating a Delta snapshot as durable", async () => {
    installIndexedDbMock();
    transactionOutcome = "abort";

    await expect(persistOfflineQueryForDeltaSync(successfulQuery as never, "user-1", 1_000))
      .rejects.toThrow(/حفظ نسخة الكاش المطلوبة قبل تثبيت مؤشر Delta/);
    expect(putCount).toBe(1);
  });

  it("resolves required Delta persistence only after IndexedDB transaction completion", async () => {
    installIndexedDbMock();
    transactionOutcome = "commit";

    await expect(persistOfflineQueryForDeltaSync(successfulQuery as never, "user-1", 1_000)).resolves.toBeUndefined();
    expect(putCount).toBe(1);
  });

});


describe("HR local-first cache boundaries", () => {
  const key = (procedure: string, input: Record<string, unknown> = { siteId: 7 }) =>
    ["powerhub.hr." + procedure, { input, type: "query" }] as const;

  it("purges only minimized HR projections for the exact denied site", () => {
    for (const procedure of ["offlineDirectory", "offlineAttendance", "offlineEmployeeAdvances", "offlinePayrollRuns", "offlineCompanyAccountOptions"]) {
      expect(isOfflineHrProjectionQueryKeyForSite(key(procedure), 7)).toBe(true);
    }
    expect(isOfflineHrProjectionQueryKeyForSite(key("offlineDirectory", { siteId: 8 }), 7)).toBe(false);
    expect(isOfflineHrProjectionQueryKeyForSite(key("offlineDirectory", { siteId: 7, search: "person" }), 7)).toBe(false);
    expect(isOfflineHrProjectionQueryKeyForSite(key("listEmployees"), 7)).toBe(false);
    expect(isOfflineHrProjectionQueryKeyForSite(key("offlineDirectory"), 0)).toBe(false);
    expect(isOfflineHrProjectionQueryKeyForSite(key("offlineAttendance"), 7, ["offlineDirectory"])).toBe(false);
    expect(isOfflineHrProjectionQueryKeyForSite(key("offlineDirectory"), 7, ["offlineDirectory"])).toBe(true);
    expect(clearOfflineHrProjectionCacheForSite).toBeTypeOf("function");
  });

  it("allows only exact minimized HR read projections, and gives Delta only to directory and attendance", () => {
    const directory = key("offlineDirectory");
    const attendance = key("offlineAttendance");
    const advances = key("offlineEmployeeAdvances");
    const payroll = key("offlinePayrollRuns");
    const accountOptions = key("offlineCompanyAccountOptions");
    for (const queryKey of [directory, attendance, advances, payroll, accountOptions]) {
      expect(isOfflineCacheableQueryKey(queryKey)).toBe(true);
    }
    expect(isDeltaSyncBackedQueryKey(directory)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(attendance)).toBe(true);
    expect(getOfflineQueryDeltaEntity(directory)).toBe("hr_employee_directory");
    expect(getOfflineQueryDeltaEntity(attendance)).toBe("hr_attendance");
    for (const queryKey of [advances, payroll, accountOptions]) {
      expect(isDeltaSyncBackedQueryKey(queryKey)).toBe(false);
      expect(getOfflineQueryDeltaEntity(queryKey)).toBeNull();
      expect(getOfflineQueryStaleTime(queryKey)).toBe(30_000);
    }
    for (const queryKey of [
      key("listEmployees"),
      key("listAttendance"),
      key("overview"),
      key("listPayrollRuns"),
      key("getPayrollDetails", { siteId: 7, payrollRunId: 3 }),
      key("offlineDirectory", { siteId: 7, search: "name" }),
      key("offlineAttendance", { siteId: 7, fromDate: "2026-10-01" }),
    ]) {
      expect(isOfflineCacheableQueryKey(queryKey)).toBe(false);
      expect(isDeltaSyncBackedQueryKey(queryKey)).toBe(false);
    }
  });

  it("strips private employee, repayment and payroll details before they reach IndexedDB", () => {
    const directory = sanitizeOfflineQueryData(key("offlineDirectory"), [{
      id: 10, tenantId: 2, siteId: null, fullName: "Employee", jobTitle: "worker",
      employmentStatus: "active", contractType: "monthly", versionNo: 4, pendingOffline: true,
      identityNo: "PRIVATE-ID", phone: "PRIVATE-PHONE", baseWage: "9999",
      notes: "PRIVATE-NOTE", linkedUserId: 88, linked_user_id: 88,
    }]) as Array<Record<string, unknown>>;
    expect(directory[0]).toMatchObject({ id: 10, fullName: "Employee", siteId: null, versionNo: 4 });
    for (const field of ["identityNo", "identity_no", "phone", "baseWage", "base_wage", "notes", "linkedUserId", "linked_user_id"]) {
      expect(directory[0]).not.toHaveProperty(field);
    }

    const attendance = sanitizeOfflineQueryData(key("offlineAttendance"), [{
      id: 20, tenantId: 2, siteId: 7,
      attendance: {
        id: 20, tenantId: 2, employeeId: 10, siteId: 7, workDate: "2026-10-29",
        regularHours: "8", overtimeHours: "1", absentDays: "0", notes: "PRIVATE-ATTENDANCE-NOTE",
        createdByUserId: 33, versionNo: 7, pendingOffline: true,
      },
      employee: { id: 10, tenantId: 2, siteId: null, fullName: "Employee", jobTitle: "worker",
        employmentStatus: "active", identityNo: "PRIVATE-ID", phone: "PRIVATE-PHONE", baseWage: "9999" },
    }]) as Array<Record<string, any>>;
    expect(attendance[0].attendance).toMatchObject({ notes: null, createdByUserId: null, versionNo: 7, pendingOffline: true });
    for (const field of ["identityNo", "identity_no", "phone", "baseWage", "base_wage"]) {
      expect(attendance[0].employee).not.toHaveProperty(field);
    }

    const advances = sanitizeOfflineQueryData(key("offlineEmployeeAdvances"), [{
      adjustment: { id: 30, tenantId: 2, siteId: 7, employeeId: 10, amount: "100", remainingAmount: "40",
        reason: "PRIVATE-REASON", createdByUserId: 33 },
      employee: { id: 10, tenantId: 2, siteId: null, fullName: "Employee", jobTitle: "worker",
        employmentStatus: "active", phone: "PRIVATE-PHONE", baseWage: "9999" },
      repayments: [{ id: 31, amount: "60", notes: "PRIVATE-REPAYMENT-NOTE",
        referenceNo: "PRIVATE-REFERENCE", createdByUserId: 33, accountTransactionId: 44 }],
    }]) as Array<Record<string, any>>;
    expect(advances[0].adjustment.reason).toBeNull();
    expect(advances[0].adjustment.createdByUserId).toBeNull();
    expect(advances[0].employee).not.toHaveProperty("phone");
    expect(advances[0].employee).not.toHaveProperty("baseWage");
    expect(advances[0].repayments[0]).toMatchObject({ notes: null, referenceNo: null, createdByUserId: null, accountTransactionId: null });

    const options = sanitizeOfflineQueryData(key("offlineCompanyAccountOptions"), [{
      id: 71, name: "Cash", accountType: "cash", isActive: true, phoneNumber: "PRIVATE-PHONE",
      balance: "9999", transactions: [{ id: 8, description: "PRIVATE-MOVEMENT" }],
    }]) as Array<Record<string, unknown>>;
    expect(options).toEqual([{ id: 71, name: "Cash", accountType: "cash", isActive: true }]);

    const payroll = sanitizeOfflineQueryData(key("offlinePayrollRuns"), [{
      id: 40, tenantId: 2, siteId: 7, period: "2026-10", status: "draft",
      totalGross: "100", totalDeductions: "20", totalNet: "80",
      payrollItems: [{ employeeId: 10, baseAmount: "100", notes: "PRIVATE" }],
      approvalToken: "PRIVATE", createdByUserId: 33,
    }]) as Array<Record<string, unknown>>;
    expect(payroll[0]).toMatchObject({ id: 40, period: "2026-10", totalNet: "80" });
    for (const field of ["payrollItems", "approvalToken", "createdByUserId"]) expect(payroll[0]).not.toHaveProperty(field);
  });
});


describe("dynamic subscriber directory and minimized expense selector cache", () => {
  it("persists bounded unfiltered, search and subscription-type directory pages through subscriber Delta", () => {
    const keys = [
      ["powerhub.subscribers.directoryPage", { input: { siteId: 7, page: 1, pageSize: 20, search: "" }, type: "query" }],
      ["powerhub.subscribers.directoryPage", { input: { siteId: 7, page: 2, pageSize: 20, search: "أحمد" }, type: "query" }],
      ["powerhub.subscribers.directoryPage", { input: { siteId: 7, page: 1, pageSize: 20, search: "059", subscriptionType: "commercial" }, type: "query" }],
    ] as const;
    for (const key of keys) {
      expect(isOfflineCacheableQueryKey(key)).toBe(true);
      expect(isDeltaSyncBackedQueryKey(key)).toBe(true);
      expect(getOfflineQueryDeltaEntity(key)).toBe("subscribers");
      expect(getOfflineQueryStaleTime(key)).toBe(Number.POSITIVE_INFINITY);
    }
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 20, search: "x", subscriptionType: "unknown" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 50, search: "x" }, type: "query",
    }])).toBe(false);
  });

  it("stores only account labels and IDs for offline expense selection for 24 hours, not as a Delta feed", () => {
    const key = ["powerhub.expenses.filterAccounts", { input: { siteId: 7 }, type: "query" }] as const;
    expect(isOfflineCacheableQueryKey(key)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(key)).toBe(false);
    expect(getOfflineQueryDeltaEntity(key)).toBeNull();
    expect(getOfflineQueryStaleTime(key)).toBe(30_000);
    expect(OFFLINE_EXPENSE_FILTER_OPTIONS_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const safe = sanitizeOfflineQueryData(key, [
      { id: 2, name: "Main", accountType: "cash", balance: "500.00", openingBalance: "450.00" },
    ]);
    expect(safe).toEqual([{ id: 2, name: "Main", accountType: "cash" }]);
  });
});
