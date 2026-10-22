import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("inventory workspace UI contract", () => {
  it("registers a protected route and a capability-gated navigation entry", () => {
    const app = read("client/src/App.tsx");
    const menu = read("client/src/components/DashboardLayout.tsx");
    const preload = read("client/src/lib/route-preload.ts");
    const runtimeRouter = read("server/powerhub-runtime-router.ts");
    const canonicalRouter = read("server/powerhub.ts");
    expect(app).toContain('const InventoryWorkspacePage = lazy(() => import("./pages/InventoryWorkspacePage"));');
    expect(app).toContain('<Route path={"/inventory"}>{() => <RouteAccessGate><InventoryWorkspacePage /></RouteAccessGate>}</Route>');
    expect(menu).toContain('label: "المخزون والمشتريات والصيانة", path: "/inventory", capability: "viewInventory"');
    expect(preload).toContain('"/inventory": () => import("../pages/InventoryWorkspacePage")');
    expect(runtimeRouter).toContain("inventory: powerhubInventoryRouter");
    expect(runtimeRouter).toContain("}) as unknown as typeof powerhubRouter;");
    expect(canonicalRouter).toContain("inventory: powerhubInventoryRouter");
    expect(read("client/src/pages/InventoryWorkspacePage.tsx")).toContain("InventoryPurchasesPanel");
    expect(menu).toContain("المخزون والمشتريات والصيانة");
  });

  it("keeps the unified workspace tabs horizontal and does not treat item definition as stock receipt", () => {
    const page = read("client/src/pages/InventoryWorkspacePage.tsx");
    expect(page).toContain('TabsTrigger value="catalog"');
    expect(page).toContain('TabsTrigger value="suppliers"');
    expect(page).toContain('TabsTrigger value="warehouses"');
    expect(page).toContain('TabsTrigger value="stock"');
    expect(page).toContain("InventoryStockOperationsPanel");
    expect(page).toContain('permissions.includes("issueInventory")');
    expect(page).toContain('permissions.includes("adjustInventory")');
    expect(page).toContain("const canReadPurchases = canViewPurchases || canReceiveInventory || canManageSupplierPayments || canAdjustInventory;");
    expect(page).toContain('permissions.includes("manageFuelAndConsumption")');
    expect(page).toContain("overflow-x-auto");
    expect(page).toContain('supplierAccess.data?.permissions.includes("viewSuppliers")');
    expect(page).toContain("canViewSuppliers ? <TabsTrigger value=\"suppliers\"");
    expect(page).toContain("useBranchFilter(sites.data)");
    expect(page).toContain("المخزون والمشتريات والصيانة");
    expect(page).toContain("تعريف الصنف لا يضيف كمية إلى المخزون");
    expect(page).toContain("trpc.powerhub.inventory.createItem.useMutation");
    expect(page).toContain("trpc.powerhub.inventory.createSupplier.useMutation");
    expect(page).toContain("trpc.powerhub.inventory.createWarehouse.useMutation");
    const purchasePanel = read("client/src/components/InventoryPurchasesPanel.tsx");
    expect(purchasePanel).toContain("recordSupplierPayment.useMutation");
    expect(purchasePanel).toContain("حالة السداد");
    expect(purchasePanel).toContain("مسددة بالكامل");
    expect(purchasePanel).toContain("مسددة جزئيًا");
    expect(purchasePanel).toContain("على الحساب — غير مدفوعة");
    expect(purchasePanel).toContain("سجل دفعات المورد");
    expect(purchasePanel).toContain("تُسجل الدفعة والسحب من حساب الشركة وتخصيص الفاتورة وقيد المورد في معاملة واحدة");
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    expect(workspace).toContain('permissions.includes("manageSupplierPayments")');
    expect(workspace).toContain("canManageSupplierPayments={canManageSupplierPayments}");
  });

  it("wires purchase draft, approval and receipt UI to guarded purchase procedures", () => {
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const panel = read("client/src/components/InventoryPurchasesPanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    expect(workspace).toContain('canReadPurchases ? <TabsTrigger value="purchases"');
    expect(workspace).toContain("canCreatePurchases={canCreatePurchases}");
    expect(panel).toContain("trpc.powerhub.inventory.listPurchases.useQuery");
    expect(panel).toContain("trpc.powerhub.inventory.createPurchase.useMutation");
    expect(panel).toContain("trpc.powerhub.inventory.confirmPurchase.useMutation");
    expect(panel).toContain("trpc.powerhub.inventory.receivePurchase.useMutation");
    expect(panel).toContain("لا تُضاف كميات إلى المخزون حتى تسجيل الاستلام");
    expect(panel).toContain("canViewFinancials");
    expect(router).toContain("requirePurchaseReadAccess");
    expect(router).toContain("resolveSupabaseSiteAccess(userId, siteId)");
    expect(router).toContain('"viewPurchases"');
    expect(router).toContain('"createPurchases"');
    expect(router).toContain('"approvePurchases"');
    expect(router).toContain('"receiveInventory"');
  });

  it("wires stock balances, movements, issue, adjustment and fuel usage to guarded RPCs", () => {
    const panel = read("client/src/components/InventoryStockOperationsPanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    expect(panel).toContain("trpc.powerhub.inventory.stockOverview.useQuery");
    expect(panel).toContain("trpc.powerhub.inventory.listStockMovements.useQuery");
    expect(panel).toContain("trpc.powerhub.inventory.recordStockMovement.useMutation");
    expect(panel).toContain("trpc.powerhub.inventory.correctStockMovement.useMutation");
    expect(panel).toContain("trpc.powerhub.inventory.returnFromIssue.useMutation");
    const transferPanel = read("client/src/components/InventoryWarehouseTransferPanel.tsx");
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    expect(transferPanel).toContain("trpc.powerhub.inventory.transferStock.useMutation");
    expect(transferPanel).toContain("sourceWarehouseId");
    expect(transferPanel).toContain("destinationWarehouseId");
    expect(transferPanel).toContain("destinationConflictsWithSource");
    expect(transferPanel).toContain("rows.find((warehouse) => String(warehouse.id) !== effectiveSourceId)");
    expect(transferPanel).toContain("stockOverview.invalidate");
    expect(workspace).toContain("InventoryWarehouseTransferPanel");
    expect(workspace).toContain("canAdjustInventory={canAdjustInventory}");
    expect(panel).toContain("source_issue_movement_id");
    expect(panel).toContain("returnable_quantity");
    expect(router).toContain("powerhub_inventory_return_from_issue");
    expect(panel).toContain("سبب التعديل");
    expect(panel).toContain("reversal_of_movement_id");
    expect(router).toContain("powerhub_inventory_correct_stock_movement");
    expect(router).toContain('"adjustInventory"');
    expect(panel).toContain("fuel_consumption");
    expect(router).toContain("powerhub_inventory_stock_overview");
    expect(router).toContain("powerhub_inventory_list_stock_movements");
    expect(router).toContain("powerhub_inventory_record_stock_movement");
    expect(panel).toContain('opening_balance: "رصيد افتتاحي"');
    expect(router).toContain('"opening_balance"');
    expect(router).toContain('value.movementType !== "opening_balance" || value.unitCost !== undefined');
    expect(router).toContain("paymentDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).optional()");
    expect(router).toContain('"issueInventory"');
    expect(router).toContain('"adjustInventory"');
    expect(router).toContain('"manageFuelAndConsumption"');
  });

  it("wires complete inventory reports, keyset paging, safe CSV export, and report-only access", () => {
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const reports = read("client/src/components/InventoryReportsPanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const menuAccess = read("client/src/lib/tenant-menu-access.ts");
    const roleTests = read("client/src/lib/tenant-menu-access.test.ts");
    const migration = read("supabase/migrations/20261021220000_powerhub_inventory_movement_report_paging.sql");
    expect(workspace).toContain('canViewInventoryReports ? <TabsTrigger value="reports"');
    expect(workspace).toContain("canViewInventoryReports={canViewInventoryReports}");
    expect(workspace).toContain('canViewInventory || canAccessStocktakes ? <TabsContent value="stock"');
    expect(workspace).toContain('canAccessStocktakes ? <InventoryStocktakePanel');
    expect(reports).toContain("trpc.powerhub.inventory.stockOverview.useQuery");
    expect(reports).toContain("trpc.powerhub.inventory.listStockMovementReport.useQuery");
    expect(reports).toContain("listStockMovementReport.fetch");
    expect(reports).toContain("downloadCsv");
    expect(reports).toContain("hasMore");
    expect(reports).toContain("exportingMoves");
    expect(reports).toContain("setTimeout");
    expect(reports).toContain('s.replace(/"/g');
    expect(router).toContain('permissions.includes("viewInventoryReports")');
    expect(router).toContain("powerhub_inventory_list_stock_movement_report");
    expect(router).toContain("listInventoryReportWarehouses: protectedProcedure");
    expect(reports).toContain("listInventoryReportWarehouses.useQuery");
    expect(menuAccess).toContain('"/inventory": { capabilities: [');
    expect(menuAccess).toContain('"viewInventory", "viewInventoryReports", "viewSuppliers", "viewPurchases"');
    expect(menuAccess).toContain('"receiveInventory", "manageSupplierPayments", "viewSupplierLedger"');
    expect(roleTests).toContain('tenantMenuRouteAllowed("/inventory", "viewer", ["manageSupplierPayments"], true)');
    expect(roleTests).toContain('tenantMenuRouteAllowed("/inventory", "viewer", ["viewInventoryReports"], true)');
    expect(migration).toContain("p_before_occurred_at");
    expect(migration).toContain("order by m.occurred_at desc, m.id desc");
  });

  it("wires supplier returns to the stock, supplier ledger, and optional company-account refund workflow", () => {
    const panel = read("client/src/components/InventoryPurchasesPanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const migration = read("supabase/migrations/20261021134343_powerhub_supplier_returns_integrated.sql");
    const precisionGuardMigration = read("supabase/migrations/20261021140313_powerhub_supplier_return_refund_precision_guard.sql");
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    expect(panel).toContain("trpc.powerhub.inventory.returnToSupplier.useMutation");
    expect(panel).toContain("سجل مرتجعات المورد");
    expect(panel).toContain("مرتجع إلى المورد");
    expect(panel).toContain("المبلغ الذي استردته الشركة نقدًا");
    expect(panel).toContain("canAdjustInventory");
    expect(panel).toContain('setReturnQuantities(Object.fromEntries(lines.map((line) => [Number(line.id), "0"])))');
    expect(workspace).toContain("canAdjustInventory={canAdjustInventory}");
    expect(router).toContain("powerhub_inventory_return_to_supplier");
    expect(router).toContain('"adjustInventory"');
    expect(router).toContain('"manageSupplierPayments"');
    expect(migration).toContain("SUPPLIER_RETURN_EXCEEDS_UNRETURNED_RECEIPT");
    expect(migration).toContain("INSUFFICIENT_STOCK_FOR_SUPPLIER_RETURN");
    expect(migration).toContain("supplier_return");
    expect(migration).toContain("related_supplier_return_id");
    expect(migration).toContain("supplier-return:");
    expect(precisionGuardMigration).toContain("v_refund_amount numeric:=coalesce(p_refund_amount,0);");
    expect(precisionGuardMigration).toContain("INVALID_SUPPLIER_RETURN_REFUND");
  });

  it("wires supplier ledger, purchase cancellation, and supplier payment reversal as guarded accounting operations", () => {
    const panel = read("client/src/components/InventoryPurchasesPanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const migration = read("supabase/migrations/20261021110452_powerhub_inventory_accounting_completion.sql");
    expect(panel).toContain("trpc.powerhub.inventory.cancelPurchase.useMutation");
    expect(panel).toContain("trpc.powerhub.inventory.reverseSupplierPayment.useMutation");
    expect(panel).toContain("معكوسة");
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    expect(workspace).toContain("trpc.powerhub.inventory.supplierLedgerStatement.useQuery");
    expect(workspace).toContain("كشف حساب المورد");
    expect(workspace).toContain('permissions.includes("viewSupplierLedger")');
    expect(panel).toContain("سبب الإلغاء");
    expect(router).toContain('"approvePurchases"');
    expect(router).toContain('"manageSupplierPayments"');
    expect(router).toContain("powerhub_inventory_cancel_purchase");
    expect(router).toContain("powerhub_inventory_reverse_supplier_payment");
    expect(router).toContain("powerhub_inventory_supplier_ledger_statement");
    expect(migration).toContain("FINANCIAL_PERIOD_LOCKED");
    expect(migration).toContain("supplier-payment-reversal:");
    expect(migration).toContain("purchase-cancellation:");
  });



  it("wires guarded lifecycle operations for items, suppliers, and warehouses without historical deletion", () => {
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const migration = read("supabase/migrations/20261022120000_powerhub_inventory_entity_lifecycle.sql");
    expect(workspace).toContain("trpc.powerhub.inventory.updateItem.useMutation");
    expect(workspace).toContain("trpc.powerhub.inventory.setItemActive.useMutation");
    expect(workspace).toContain("trpc.powerhub.inventory.updateSupplier.useMutation");
    expect(workspace).toContain("trpc.powerhub.inventory.setSupplierActive.useMutation");
    expect(workspace).toContain("trpc.powerhub.inventory.updateWarehouse.useMutation");
    expect(workspace).toContain("trpc.powerhub.inventory.setWarehouseActive.useMutation");
    expect(workspace).toContain("إظهار الأصناف الموقوفة");
    expect(workspace).toContain("إظهار الموردين الموقوفين");
    expect(workspace).toContain("إظهار المخازن الموقوفة");
    expect(workspace).toContain("supplierTaxNumber");
    expect(workspace).toContain("supplierAddress");
    expect(workspace).toContain("أدخل سبب إيقاف الصنف");
    expect(workspace).toContain("أدخل سبب إيقاف المورد");
    expect(workspace).toContain("أدخل سبب إيقاف المخزن");
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageInventoryItems")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSuppliers")');
    expect(migration).toContain("ITEM_BASE_UNIT_IMMUTABLE_AFTER_USE");
    expect(migration).toContain("ITEM_IDENTITY_IMMUTABLE_AFTER_USE");
    expect(migration).toContain("INVENTORY_ITEM_HAS_STOCK");
    expect(migration).toContain("SUPPLIER_HAS_OUTSTANDING_PAYABLE");
    expect(migration).toContain("WAREHOUSE_HAS_STOCK");
    expect(migration).toContain("historicalRowsPreserved");
    expect(migration).toContain("revoke all on function public.powerhub_inventory_update_item");
    expect(migration).toContain("revoke all on function public.powerhub_inventory_set_supplier_active");
  });
  


  it("wires standalone supplier payment batching, opening payable balances, aging, history and safe reversal", () => {
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const payments = read("client/src/components/InventorySupplierPaymentsPanel.tsx");
    const aging = read("client/src/components/InventorySupplierPayablesAgingPanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const migration = read("supabase/migrations/20261022133000_powerhub_supplier_payables_and_batch_payments.sql");
    const integration = read("supabase/tests/inventory_purchase_receiving_workflow.sql");

    expect(workspace).toContain('TabsTrigger value="supplierPayments"');
    expect(workspace).toContain('TabsContent value="supplierPayments"');
    expect(workspace).toContain("InventorySupplierPaymentsPanel");
    expect(workspace).toContain("InventorySupplierPayablesAgingPanel");
    expect(workspace).toContain('tab === "supplierPayments"');

    expect(payments).toContain("listSupplierPaymentBatchOptions.useQuery");
    expect(payments).toContain("listSupplierPaymentOptions.useQuery");
    expect(payments).toContain("recordSupplierOpeningBalance.useMutation");
    expect(payments).toContain("recordSupplierPaymentBatch.useMutation");
    expect(payments).toContain("listSupplierPaymentHistory.useQuery");
    expect(payments).toContain("reverseSupplierPayment.useMutation");
    expect(payments).toContain("مبلغ التخصيص");
    expect(payments).toContain("مجموع التخصيصات");
    expect(payments).toContain("رصيد افتتاحي مستحق للمورد");

    expect(aging).toContain("supplierPayablesAging.useQuery");
    expect(aging).toContain("days_1_30");
    expect(aging).toContain("days_31_60");
    expect(aging).toContain("days_61_90");
    expect(aging).toContain("days_91_plus");

    expect(router).toContain("supplierPayablesAging: protectedProcedure");
    expect(router).toContain("listSupplierPaymentBatchOptions: protectedProcedure");
    expect(router).toContain("listSupplierPaymentHistory: protectedProcedure");
    expect(router).toContain("recordSupplierOpeningBalance: protectedProcedure");
    expect(router).toContain("recordSupplierPaymentBatch: protectedProcedure");
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "viewSupplierLedger")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "manageSupplierPayments")');
    expect(router).toContain("powerhub_inventory_reverse_supplier_payment_flexible");
    expect(router).toContain("supplier_ledger_entry_id: allocation.openingBalanceEntryId ?? null");

    expect(migration).toContain("powerhub_inventory_record_supplier_opening_balance");
    expect(migration).toContain("powerhub_inventory_record_supplier_payment_batch");
    expect(migration).toContain("powerhub_inventory_reverse_supplier_payment_flexible");
    expect(migration).toContain("powerhub_inventory_supplier_payables_aging");
    expect(migration).toContain("supplier_payment_allocations_document_target_ck");
    expect(migration).toContain("SUPPLIER_PAYMENT_ALLOCATION_TOTAL_MISMATCH");
    expect(migration).toContain("revoke all on function public.powerhub_inventory_record_supplier_payment_batch");
    expect(migration).toContain("grant execute on function public.powerhub_inventory_record_supplier_payment_batch");

    expect(integration).toContain("$supplier_batch_payment_assertions$");
    expect(integration).toContain("BATCH_SUPPLIER_PAYMENT_CREATE_FAILED");
    expect(integration).toContain("SUPPLIER_PAYABLE_AGING_MISMATCH");
    expect(integration).toContain("BATCH_SUPPLIER_PAYMENT_REVERSAL_FAILED");
    expect(integration).toContain("AUTHENTICATED_CAN_EXECUTE_SUPPLIER_BATCH_FINANCIAL_RPC");
  });


  it("enforces durable item-specific purchase-unit conversions in UI, server, and database", () => {
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const purchases = read("client/src/components/InventoryPurchasesPanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const migration = read("supabase/migrations/20261022160000_powerhub_inventory_item_units.sql");
    const integration = read("supabase/tests/inventory_purchase_receiving_workflow.sql");

    expect(workspace).toContain("listItemUnits.useQuery");
    expect(workspace).toContain("createItemUnit.useMutation");
    expect(workspace).toContain("setItemUnitActive.useMutation");
    expect(workspace).toContain("عدد الوحدات الأساسية داخلها");
    expect(purchases).toContain("options.data?.units.filter");
    expect(purchases).toContain('String(itemUnit?.factor_to_base ?? "")');
    expect(purchases).toContain("readOnly disabled");
    expect(router).toContain("listItemUnits: protectedProcedure");
    expect(router).toContain("createItemUnit: protectedProcedure");
    expect(router).toContain("setItemUnitActive: protectedProcedure");
    expect(router).toContain("powerhub_inventory_create_item_unit");
    expect(router).toContain("powerhub_inventory_set_item_unit_active");
    expect(migration).toContain("inventory_item_units_label_unique_idx");
    expect(migration).toContain("PURCHASE_UNIT_NOT_CONFIGURED");
    expect(migration).toContain("PURCHASE_UNIT_CONVERSION_MISMATCH");
    expect(migration).toContain("ITEM_BASE_UNIT_HAS_PURCHASE_UNITS");
    expect(migration).toContain("revoke all on function public.powerhub_inventory_create_item_unit");
    expect(integration).toContain("\\ir ../migrations/20261022160000_powerhub_inventory_item_units.sql");
    expect(integration).toContain("ITEM_UNIT_CREATE_FACTOR_MISMATCH");
    expect(integration).toContain("ITEM_UNIT_MISMATCH_PROBE_SHOULD_FAIL");
    expect(integration).toContain("ITEM_UNIT_UNKNOWN_PROBE_SHOULD_FAIL");
    expect(integration).toContain("AUTHENTICATED_CAN_EXECUTE_ITEM_UNIT_RPC");
  });

  it("wires typed stock locations and enforces generator-tank ownership", () => {
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const migration = read("supabase/migrations/20261022143000_powerhub_inventory_location_types.sql");
    const integration = read("supabase/tests/inventory_purchase_receiving_workflow.sql");

    expect(workspace).toContain("warehouseTypeLabels");
    expect(workspace).toContain("warehouseGenerators = trpc.powerhub.generators.list.useQuery");
    expect(workspace).toContain('generator_fuel_tank: "خزان مرتبط بمولد"');
    expect(workspace).toContain('value={warehouseLocationType}');
    expect(workspace).toContain('warehouseLocationType === "generator_fuel_tank"');
    expect(workspace).toContain("warehouse.generator_id");
    expect(router).toContain("powerhub_inventory_create_warehouse_with_location");
    expect(router).toContain("powerhub_inventory_update_warehouse_with_location");
    expect(router).toContain("location_type,generator_id");
    expect(migration).toContain("inventory_warehouses_generator_site_tenant_fk");
    expect(migration).toContain("WAREHOUSE_IDENTITY_IMMUTABLE_AFTER_USE");
    expect(migration).toContain("STOCK_GENERATOR_OUT_OF_SCOPE");
    expect(integration).toContain("$inventory_location_type_assertions$");
    expect(integration).toContain("CROSS_SITE_GENERATOR_TANK_ACCEPTED");
    expect(integration).toContain("USED_WAREHOUSE_LOCATION_TYPE_CHANGED");
  });


  it("wires physical stocktake snapshot, counting, approval and drift-safe posting", () => {
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const panel = read("client/src/components/InventoryStocktakePanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const migration = read("supabase/migrations/20261022150000_powerhub_inventory_stocktakes.sql");
    const integration = read("supabase/tests/inventory_purchase_receiving_workflow.sql");
    const rbac = read("shared/powerhub-rbac.ts");
    const menuAccess = read("client/src/lib/tenant-menu-access.ts");

    expect(workspace).toContain("InventoryStocktakePanel");
    expect(workspace).toContain("canViewStocktakes");
    expect(workspace).toContain("canManageStocktakes");
    expect(workspace).toContain("canApproveStocktakes");
    expect(panel).toContain("listStocktakeWarehouses.useQuery");
    expect(panel).toContain("listStocktakes.useQuery");
    expect(panel).toContain("listStocktakeLines.useQuery");
    expect(panel).toContain("createStocktake.useMutation");
    expect(panel).toContain("recordStocktakeCount.useMutation");
    expect(panel).toContain("submitStocktake.useMutation");
    expect(panel).toContain("postStocktake.useMutation");
    expect(panel).toContain("cancelStocktake.useMutation");
    expect(panel).toContain('(selectedStocktake.status === "counting" || selectedStocktake.status === "submitted") && canManageStocktakes');
    expect(panel).toContain("ألغِ الجلسة بسبب موثق ثم افتح جلسة جديدة");
    expect(migration).toContain("v_stocktake.status not in ('counting','submitted')");
    expect(integration).toContain("STALE_SUBMITTED_STOCKTAKE_WAS_POSTED");
    expect(integration).toContain("NEW_STOCKTAKE_BLOCKED_AFTER_STALE_CANCELLATION");
    expect(panel).toContain("لقطة أرصدة مرجعية");
    expect(panel).toContain("إرسال للاعتماد");
    expect(panel).toContain("اعتماد وترحيل");
    expect(router).toContain("requireStocktakeReadAccess");
    expect(router).toContain("requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], \"manageStocktakes\")");
    expect(router).toContain("requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], \"approveStocktakes\")");
    expect(migration).toContain("inventory_stocktakes_one_open_per_warehouse_idx");
    expect(migration).toContain("STOCKTAKE_STOCK_CHANGED_DURING_COUNT");
    expect(migration).toContain("powerhub_inventory_stocktake_snapshot_is_current");
    expect(migration).toContain("powerhub_inventory_record_stock_movement");
    expect(migration).toContain("FUEL_ITEM_REQUIRED_FOR_TANK");
    expect(migration).toContain("viewStocktakes");
    expect(migration).toContain("manageStocktakes");
    expect(migration).toContain("approveStocktakes");
    expect(integration).toContain("$inventory_stocktake_assertions$");
    expect(integration).toContain("STOCKTAKE_POST_REPLAY_DUPLICATED_MOVEMENT");
    expect(integration).toContain("STOCKTAKE_WITH_STALE_SNAPSHOT_WAS_SUBMITTED");
    expect(integration).toContain("AUTHENTICATED_CAN_EXECUTE_STOCKTAKE_RPC");
    expect(rbac).toContain("viewStocktakes");
    expect(rbac).toContain("manageStocktakes");
    expect(rbac).toContain("approveStocktakes");
    expect(menuAccess).toContain('"viewStocktakes", "manageStocktakes", "approveStocktakes"');
  });

});
