import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("offline data and financial truth boundaries", () => {
  it("never substitutes the unfiltered latest-100 fuel feed for a filtered historical result", () => {
    const fuel = read("client/src/components/InventoryFuelConsumptionPanel.tsx");
    expect(fuel).toContain("const hasFilteredEventQuery = Boolean(fromDate || toDate || activeReportGeneratorId)");
    expect(fuel).toContain(": !hasFilteredEventQuery ? recentEvents.data ?? [] : []");
    expect(fuel).toContain("const hasFilteredReadingQuery = Boolean(activeReportGeneratorId)");
    expect(fuel).toContain(": !hasFilteredReadingQuery ? recentReadings.data ?? [] : []");
    expect(fuel).toContain("const recentEvents = trpc.powerhub.inventory.listFuelEvents.useQuery");
    expect(fuel).toContain("const recentReadings = trpc.powerhub.inventory.listFuelReadings.useQuery");
    expect(fuel).toContain('if (eventsChanged && hasFilteredEventQuery) void events.refetch()');
    expect(fuel).toContain('if (readingsChanged && hasFilteredReadingQuery) void readings.refetch()');
  });

  it("stores calculated fuel and maintenance reports as exact-filter snapshots, not Delta row feeds", () => {
    const cache = read("client/src/lib/offline-operational-report-cache.ts");
    const fuel = read("client/src/components/InventoryFuelConsumptionPanel.tsx");
    const maintenance = read("client/src/components/InventoryMaintenancePanel.tsx");
    expect(cache).toContain("snapshot.key !== makeKey(input)");
    expect(cache).toContain('JSON.stringify(snapshot.filters) !== JSON.stringify(input.filters)');
    expect(cache).toContain("OFFLINE_OPERATIONAL_REPORT_TTL_MS = 24 * 60 * 60 * 1000");
    expect(fuel).toContain('reportType: "fuel-consumption" as const');
    expect(fuel).toContain("periodType: reportPeriodType");
    expect(fuel).toContain("generatorId: activeReportGeneratorId ? Number(activeReportGeneratorId) : null");
    expect(fuel).toContain("tankWarehouseId: reportTankId ? Number(reportTankId) : null");
    expect(fuel).toContain("hasAuthoritativeServerRead(report)");
    expect(fuel).toContain("void report.refetch()");
    expect(maintenance).toContain('reportType: "maintenance" as const');
    expect(maintenance).toContain("fromDate: reportFromDate");
    expect(maintenance).toContain("toDate: reportToDate");
    expect(maintenance).toContain("generatorId: reportGeneratorId ? Number(reportGeneratorId) : null");
    expect(maintenance).toContain("hasAuthoritativeServerRead(maintenanceReport)");
    expect(maintenance).toContain('MAINTENANCE_REVISION_ENTITIES = ["maintenance_work_orders"]');
    expect(maintenance).toContain("void maintenanceReport.refetch()");
    expect(maintenance).not.toContain('"maintenance_reports"');
  });

  it("keeps HR company-account options as a minimized 24-hour cache, not a Delta projection", () => {
    const cache = read("client/src/lib/offline-query-cache.ts");
    const tests = read("client/src/lib/offline-query-cache.test.ts");
    expect(cache).toContain("OFFLINE_HR_COMPANY_ACCOUNT_OPTIONS_TTL_MS = 24 * 60 * 60 * 1000");
    expect(cache).toContain('cacheKeySegments[2] === "offlineCompanyAccountOptions"');
    expect(cache).toContain("now + hrCacheTtl");
    expect(cache).toContain('id: row.id, name: String(row.name ?? "")');
    expect(cache).toContain("accountType: String(row.accountType ?? row.account_type ?? \"other\")");
    expect(cache).not.toContain('entityType: "hr_company_account_options"');
    expect(tests).toContain("OFFLINE_HR_COMPANY_ACCOUNT_OPTIONS_TTL_MS).toBe(24 * 60 * 60 * 1000)");
    expect(tests).toContain("expect(isDeltaSyncBackedQueryKey(accountOptions)).toBe(false)");
    expect(tests).toContain('balance: "9999", transactions: [{ id: 8, description: "PRIVATE-MOVEMENT" }]');
  });

  it("does not treat retained financial reports, supplier aging, or supplier statements as verified money", () => {
    const readGate = read("client/src/lib/authoritative-server-read.ts");
    const reports = read("client/src/pages/ReportsPage.tsx");
    const aging = read("client/src/components/InventorySupplierPayablesAgingPanel.tsx");
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    expect(readGate).toContain("state.isFetchedAfterMount === true");
    expect(readGate).toContain("state.isFetching !== true");
    expect(reports).toContain("hasAuthoritativeServerRead(activeQuery)");
    expect(reports).toContain("!liveReport || usingCachedReport || reportAccessDenied");
    expect(aging).toContain("hasServerValidatedResult");
    expect(aging).toContain("if (!hasServerValidatedResult || authorizationDenied || !result)");
    expect(workspace).toContain("supplierLedgerIsAuthoritative");
    expect(workspace).toContain("supplierLedgerRequiresRevalidation");
    expect(workspace).toContain('"غير مؤكد"');
  });

  it("requires current server data before supplier posting, receipt, return, or settlement", () => {
    const purchases = read("client/src/components/InventoryPurchasesPanel.tsx");
    const supplierPayments = read("client/src/components/InventorySupplierPaymentsPanel.tsx");
    expect(purchases).toContain("const purchasesAreAuthoritative = hasAuthoritativeServerRead(purchases)");
    expect(purchases).toContain("const detailsIsAuthoritative = Boolean(");
    expect(purchases).toContain("if (!detailsIsAuthoritative || !hasAuthoritativeServerRead(paymentOptions))");
    expect(purchases).toContain("if (!detailsIsAuthoritative) {");
    expect(purchases).toContain("const currentPaymentOptions = paymentOptionsAreAuthoritative ? paymentOptions.data ?? [] : []");
    expect(purchases.match(/paymentOptions\.data/g) ?? []).toHaveLength(1);
    expect(supplierPayments).toContain("if (!batchOptionsIsAuthoritative || !accountOptionsIsAuthoritative)");
    expect(supplierPayments).toContain("if (!batchOptionsIsAuthoritative) {");
    expect(supplierPayments).toContain("if (!ensureServerWriteAllowed()) return;");
    expect(purchases).toContain("if (!ensureServerWriteAllowed()) return;");
    expect(purchases).toContain("تم اعتماد الفاتورة، لكن الاتصال انقطع قبل السداد");
  });

  it("keeps final inventory movements and postings behind the trusted server connectivity gate", () => {
    const stock = read("client/src/components/InventoryStockOperationsPanel.tsx");
    const stocktake = read("client/src/components/InventoryStocktakePanel.tsx");
    const transfer = read("client/src/components/InventoryWarehouseTransferPanel.tsx");
    const purchases = read("client/src/components/InventoryPurchasesPanel.tsx");
    for (const source of [stock, stocktake, transfer, purchases]) {
      expect(source).toContain("ensureServerWriteAllowed");
      expect(source).toContain("getPowerHubConnectivitySnapshot() !== true");
    }
    expect(stock).toContain("recordMovement.mutate");
    expect(stocktake).toContain("postStocktake.mutate");
    expect(transfer).toContain("transfer.mutate");
    expect(purchases).toContain("receivePurchase.mutate");
    expect(purchases).toContain("returnToSupplier.mutate");
    expect(purchases).toContain("recordSupplierPayment.mutate");
  });

  it("persists HR and fuel offline work only as shared Outbox intents, then applies them after server replay", () => {
    const queue = read("client/src/lib/offline-work-queue.ts");
    const sync = read("client/src/components/OfflineWorkSyncPanel.tsx");
    const fuel = read("client/src/components/InventoryFuelConsumptionPanel.tsx");
    const contracts = read("client/src/lib/offline-work-queue.contract.test.ts");
    for (const kind of [
      "employee_create", "employee_update", "attendance_upsert", "payroll_draft",
      "employee_advance_issue", "employee_advance_repayment", "fuel_fill",
    ]) expect(queue).toContain(`"${kind}"`);
    expect(queue).toContain("clientOperationId");
    expect(queue).toContain("dependsOn");
    expect(sync).toContain("operationKey: item.clientOperationId");
    expect(sync).toContain("await runMutation(() => recordFuelFill.mutateAsync");
    expect(sync).toContain('status: "applied"');
    expect(fuel).toContain('kind: "fuel_fill", clientOperationId: fillKey, payload');
    expect(fuel).not.toContain("stockOverview.setData");
    expect(fuel).not.toContain("listStockMovements.setData");
    expect(contracts).toContain("offline fuel fill intent contract");
    expect(contracts).toContain("HR offline outbox contract");
  });
});
