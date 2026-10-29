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
    expect(menu).toContain('label: "التشغيل والمشتريات", path: "/inventory"');
    expect(menu).not.toContain('label: "المحطات والمولدات", path: "/generators"');
    expect(preload).toContain('"/inventory": () => import("../pages/InventoryWorkspacePage")');
    expect(runtimeRouter).toContain("inventory: powerhubInventoryRouter");
    expect(runtimeRouter).toContain("}) as unknown as typeof powerhubRouter;");
    expect(canonicalRouter).toContain("inventory: powerhubInventoryRouter");
    expect(read("client/src/pages/InventoryWorkspacePage.tsx")).toContain("InventoryPurchasesPanel");
    expect(menu).toContain("التشغيل والمشتريات");
  });

  it("keeps the unified workspace tabs horizontal and does not treat item definition as stock receipt", () => {
    const page = read("client/src/pages/InventoryWorkspacePage.tsx");
    expect(page).toContain('TabsTrigger value="generators"');
    expect(page).toContain('<NetworkDirectoryPage kind="generators" embedded />');
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
    expect(page).toContain("التشغيل والمشتريات");
    expect(page).toContain("تعريف الصنف لا يضيف كمية إلى المخزون");
    expect(page).toContain("trpc.powerhub.inventory.createItem.useMutation");
    expect(page).toContain("trpc.powerhub.inventory.createSupplier.useMutation");
    expect(page).toContain("trpc.powerhub.inventory.createWarehouse.useMutation");
    const runtimeRouter = read("server/powerhub-inventory-router.ts");
    const purchasePanel = read("client/src/components/InventoryPurchasesPanel.tsx");
    expect(purchasePanel).toContain("recordSupplierPayment.useMutation");
    expect(purchasePanel).toContain("حالة السداد");
    expect(page).toContain("supplierType");
    expect(page).toContain("نوع المورد");
    expect(purchasePanel).toContain('useState<"immediate" | "deferred">("deferred")');
    expect(purchasePanel).toContain("confirmPurchase.mutateAsync");
    expect(purchasePanel).toContain("recordSupplierPayment.mutateAsync");
    expect(runtimeRouter).toContain("powerhub_inventory_create_supplier_with_type");
    expect(runtimeRouter).toContain('p_payment_mode: input.paymentMode ?? "deferred"');
    expect(purchasePanel).toContain("مسددة بالكامل");
    expect(purchasePanel).toContain("مسددة جزئيًا");
    expect(purchasePanel).toContain("على الحساب — غير مدفوعة");
    expect(purchasePanel).toContain("سجل دفعات المورد");
    expect(purchasePanel).toContain("تُسجل الدفعة والسحب من حساب الشركة وتخصيص الفاتورة وقيد المورد في معاملة واحدة");
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    expect(workspace).toContain('permissions.includes("manageSupplierPayments")');
    expect(workspace).toContain("canManageSupplierPayments={canManageSupplierPayments}");
  });

  it("separates supplier payment posting and reversal permissions at UI, server, RBAC, and SQL layers", () => {
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const panel = read("client/src/components/InventorySupplierPaymentsPanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const admin = read("client/src/pages/AdminAdvancedWorkspace.tsx");
    const api = read("server/admin-role-policy-router.ts");
    const rbac = read("shared/powerhub-rbac.ts");
    const migration = read("supabase/migrations/20261022170000_powerhub_inventory_operation_permissions.sql");
    const integration = read("supabase/tests/inventory_purchase_receiving_workflow.sql");
    expect(workspace).toContain('permissions.includes("reverseSupplierPayments")');
    expect(workspace).toContain("canReverseSupplierPayments={canReverseSupplierPayments}");
    expect(panel).toContain("canReverseSupplierPayments: boolean");
    expect(panel).toContain("!canReverseSupplierPayments");
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "reverseSupplierPayments")');
    expect(admin).toContain('id: "reverseSupplierPayments"');
    expect(api).toContain('"reverseSupplierPayments"');
    expect(rbac).toContain('reverseSupplierPayments: ["owner", "accountant"]');
    expect(migration).toContain("'reverseSupplierPayments'");
    expect(integration).toContain("'reverseSupplierPayments'");
  });

  it("shows the effective permission after role-policy restrictions and supports both owners and staff", () => {
    const admin = read("client/src/pages/AdminAdvancedWorkspace.tsx");
    const api = read("server/admin-role-policy-router.ts");
    const resolver = read("server/powerhub-supabase.ts");
    const ownerMigration = read("supabase/migrations/20261022200000_powerhub_owner_capability_overrides.sql");
    const ownerIntegration = read("supabase/tests/staff_inventory_permissions.sql");
    expect(admin).toContain('const policyAllows = lookup.get(`${selectedTarget.role}:${capability.id}`) ?? true');
    expect(admin).toContain('const configured = explicit ? Boolean(userOverrides.get(capability.id)) : effectiveBase.has(capability.id)');
    expect(admin).toContain("const checked = policyAllows && configured");
    expect(admin).toContain("checked={configured}");
    expect(admin).toContain("ممنوعة بسياسة المنصة");
    expect(admin).toContain("مسموحة فعليًا — موروثة من الدور");
    expect(admin).toContain("ممنوعة فعليًا — موروثة من الدور");
    expect(api).toContain('targetType: "owner" as const');
    expect(api).toContain('targetType: "staff" as const');
    expect(api).toContain("powerhub_admin_set_owner_capability_override");
    expect(api).toContain("tenant_member_capability_overrides");
    expect(resolver).toContain('tenant_member_capability_overrides(capability,is_allowed)');
    expect(resolver).toContain("applyStaffCapabilityOverrides(allCapabilities, ownerOverrides)");
    expect(ownerMigration).toContain("tenant_member_permission_audit");
    expect(ownerMigration).toContain("OWNER_MEMBERSHIP_NOT_FOUND");
    expect(ownerMigration).toContain("grant execute on function public.powerhub_admin_set_owner_capability_override");
    expect(ownerIntegration).toContain("OWNER_INDIVIDUAL_PERMISSION_DENY_FAILED");
    expect(ownerIntegration).toContain("OWNER_PERMISSION_AUDIT_IDEMPOTENCY_FAILED");
  });

  it("keeps tenant audit actors compatible with the shared audit schema", () => {
    const actorFix = read("supabase/migrations/20261022180000_powerhub_inventory_actor_audit_role_fix.sql");
    const supplierReturnFix = read("supabase/migrations/20261022183000_powerhub_supplier_return_actor_audit_role_fix.sql");
    const unitAuditFix = read("supabase/migrations/20261022193000_powerhub_inventory_item_unit_audit_metadata_fix.sql");
    const integration = read("supabase/tests/inventory_purchase_receiving_workflow.sql");
    expect(actorFix).not.toContain("coalesce(u.platform_role,'tenant_user')");
    expect(supplierReturnFix).not.toContain("coalesce(u.platform_role,'tenant_user')");
    expect(unitAuditFix).toContain("u.platform_role");
    expect(unitAuditFix).toContain("action,before_data,after_data,metadata");
    expect(unitAuditFix).toContain("jsonb_build_object('reason',v_reason)");
    expect(unitAuditFix).not.toContain("after_data,reason");
    expect(integration).toContain("\\ir ../migrations/20261022180000_powerhub_inventory_actor_audit_role_fix.sql");
    expect(integration).toContain("\\ir ../migrations/20261022183000_powerhub_supplier_return_actor_audit_role_fix.sql");
    expect(integration).toContain("\\ir ../migrations/20261022193000_powerhub_inventory_item_unit_audit_metadata_fix.sql");
    expect(integration).toContain("TENANT_AUDIT_SUPPLIER_RETURN_FAILED");
  });

  it("exports supplier payable aging as a full Excel worksheet and Arabic PDF under ledger permission", () => {
    const panel = read("client/src/components/InventorySupplierPayablesAgingPanel.tsx");
    expect(panel).toContain("canViewSupplierLedger");
    expect(panel).toContain('import { loadExcelJS } from "@/lib/lazy-report-deps"');
    expect(panel).toContain('import { downloadReportHtmlAsPdf, escapeHtml } from "@/lib/report-pdf"');
    expect(panel).toContain('workbook.addWorksheet("أعمار ذمم الموردين"');
    expect(panel).toContain("result.rows.map");
    expect(panel).toContain("downloadReportHtmlAsPdf(root");
    expect(panel).toContain("PDF عربي");
    expect(panel).toContain("Excel");
    expect(panel).toContain("5_000");
    expect(panel).toContain('views: [{ rightToLeft: true');
  });

  it("renders Phase D source-backed dashboard filters, financial summaries, and export contracts", () => {
    const page = read("client/src/pages/InventoryWorkspacePage.tsx");
    const dashboard = read("client/src/components/InventoryDashboardPanel.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    expect(page).toContain('const [tab, setTab] = useState("dashboard")');
    expect(page).toContain('TabsTrigger value="dashboard"');
    expect(page).toContain('TabsContent value="dashboard"');
    expect(page).toContain("InventoryDashboardPanel");
    expect(dashboard).toContain("trpc.powerhub.inventory.stockOverview.useQuery");
    expect(dashboard).toContain("trpc.powerhub.inventory.supplierPayablesAging.useQuery");
    expect(dashboard).toContain("canViewInventoryReports ? <Metric label=\"القيمة الدفترية للمخزون\"");
    expect(dashboard).toContain("canViewSupplierLedger ? <Metric label=\"الذمم المستحقة للموردين\"");
    expect(page).toContain("siteName={siteName}");
    expect(page).toContain("canManageFuelAndConsumption={canManageFuelAndConsumption}");
    expect(dashboard).toContain("phaseDFinancialSummary.useQuery");
    expect(dashboard).toContain("fuelConsumptionReportPeriod.useQuery");
    expect(dashboard).toContain("maintenance.reportByGenerator.useQuery");
    expect(dashboard).toContain("readingCycle.boundsAt.useQuery");
    expect(dashboard).toContain("تصنيف الصنف");
    expect(dashboard).toContain("listInventoryReportWarehouses.useQuery");
    expect(dashboard).toContain("warehouseId !== \"all\"");
    expect(dashboard).toContain("generatorOperatingRows");
    expect(dashboard).toContain("تكلفة تشغيل المولدات");
    expect(dashboard).toContain("workbook.addWorksheet");
    expect(dashboard).toContain("التكلفة التشغيلية المسجلة حسب المولد");
    expect(dashboard).toContain("تطبق على الأرصدة والحركات فقط");
    expect(dashboard).toContain("gazaTimestamp()");
    expect(dashboard).toContain("timeZone: \"Asia/Gaza\"");
    expect(dashboard).toContain("دفعات الموردين المرحلة");
    expect(dashboard).toContain("ائتمانات مرتجعات الموردين");
    expect(dashboard).toContain("لا يمكن أن يتجاوز نطاق التقرير 366 يومًا");
    expect(dashboard).toContain("تكلفة الصيانة المسجلة");
    expect(dashboard).toContain("ليست ترحيلًا محاسبيًا");
    expect(dashboard).toContain("loadAllFilteredMoves");
    expect(dashboard).toContain("downloadDashboardCsv");
    expect(dashboard).toContain("const csvCell = (value: unknown)");
    expect(dashboard).toContain("const untrustedText = typeof value === \"string\"");
    expect(dashboard).toContain("untrustedText = typeof value === \"string\"");
    expect(dashboard).toContain("exportDashboardExcel");
    expect(dashboard).toContain("exportDashboardPdf");
    expect(dashboard).toContain("listStockMovementReport.fetch");
    expect(dashboard).toContain("downloadReportHtmlAsPdf");
    expect(dashboard).toContain("rightToLeft");
    expect(router).toContain("categoryByItemId");
    expect(router).toContain("generator_id: row.generator_id");
    expect(router).toContain("powerhub_inventory_stock_overview");
    expect(router).toContain("powerhub_inventory_supplier_payables_aging");
    expect(router).toContain("phaseDFinancialSummary: protectedProcedure");
    expect(router).toContain("phaseDFinancialDetails: protectedProcedure");
    expect(router).toContain("new Map<number, string>");
    expect(router).toContain("powerhub_inventory_phase_d_financial_details");
    expect(router).toContain('"viewInventoryReports"');
    expect(router).toContain("powerhub_inventory_phase_d_financial_summary");
    const phaseDSummary = read("supabase/migrations/20261023110000_powerhub_inventory_phase_d_financial_summary.sql");
    const phaseDFinancialAcl = read("supabase/migrations/20261023120000_powerhub_inventory_phase_d_financial_details_acl_filter.sql");
    const integration = read("supabase/tests/inventory_purchase_receiving_workflow.sql");
    expect(phaseDSummary).toContain("p.status in ('confirmed','partially_received','received')");
    expect(phaseDSummary).toContain("p.status='posted'");
    expect(phaseDSummary).toContain("r.status='posted'");
    expect(phaseDSummary).toContain("revoke all on function public.powerhub_inventory_phase_d_financial_summary");
    expect(phaseDSummary).toContain("powerhub_inventory_phase_d_financial_details");
    expect(phaseDSummary).toContain("INVALID_PHASE_D_FINANCIAL_CURSOR");
    expect(phaseDFinancialAcl).toContain("p_include_purchase_invoices");
    expect(phaseDFinancialAcl).toContain("p_include_supplier_events");
    expect(phaseDFinancialAcl).toContain("and p_include_purchase_invoices");
    expect(phaseDFinancialAcl).toContain("and p_include_supplier_events");
    expect(integration).toContain("PHASE_D_HIDDEN_PURCHASE_EVENT_RETURNED");
    expect(integration).toContain("PHASE_D_HIDDEN_SUPPLIER_EVENT_RETURNED");
    expect(integration).toContain("PHASE_D_FINANCIAL_DETAILS_CURSOR_ORDER_FAILED");
    expect(integration).toContain("PHASE_D_FINANCIAL_DETAILS_PAYMENT_RECONCILIATION_FAILED");
    expect(integration).toContain("PHASE_D_PURCHASE_SUMMARY_RECONCILIATION_FAILED");
    expect(integration).toContain("PHASE_D_PAYMENT_SUMMARY_RECONCILIATION_FAILED");
    expect(integration).toContain("PHASE_D_FINANCIAL_SUMMARY_ACL_FAILED");
  });

  it("exports complete filtered stock reports to multi-sheet Excel and Arabic RTL PDF", () => {
    const reports = read("client/src/components/InventoryReportsPanel.tsx");
    expect(reports).toContain('import { loadExcelJS } from "@/lib/lazy-report-deps"');
    expect(reports).toContain('import { downloadReportHtmlAsPdf, escapeHtml } from "@/lib/report-pdf"');
    expect(reports).toContain('workbook.addWorksheet("ملخص التقرير"');
    expect(reports).toContain('workbook.addWorksheet("أرصدة المخزون"');
    expect(reports).toContain('workbook.addWorksheet("حركات المخزون"');
    expect(reports).toContain("await loadAllFilteredMoves()");
    expect(reports).toContain("await downloadReportHtmlAsPdf(root");
    expect(reports).toContain('dir="rtl"');
    expect(reports).toContain("Excel متعدد الأوراق");
    expect(reports).toContain("PDF عربي");
    expect(reports).toContain("100,000 حركة");
    expect(reports).toContain("5,000 حركة");
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
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createInventoryItems")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "editInventoryItems")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "deactivateInventoryItems")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createWarehouses")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "editWarehouses")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "deactivateWarehouses")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "createSuppliers")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "editSuppliers")');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], "deactivateSuppliers")');
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


  it("separates create, edit, and deactivate permissions for inventory master data", () => {
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const admin = read("client/src/pages/AdminAdvancedWorkspace.tsx");
    const schema = read("server/admin-role-policy-router.ts");
    const rbac = read("shared/powerhub-rbac.ts");
    const migration = read("supabase/migrations/20261022170000_powerhub_inventory_operation_permissions.sql");
    const integration = read("supabase/tests/inventory_purchase_receiving_workflow.sql");

    for (const capability of [
      "createInventoryItems","editInventoryItems","deactivateInventoryItems",
      "createSuppliers","editSuppliers","deactivateSuppliers",
      "createWarehouses","editWarehouses","deactivateWarehouses",
    ]) {
      expect(workspace).toContain(`permissions.includes("${capability}")`);
      expect(admin).toContain(`id: "${capability}"`);
      expect(schema).toContain(`"${capability}"`);
      expect(rbac).toContain(`"${capability}"`);
      expect(migration).toContain(`'${capability}'`);
    }
    expect(integration).toContain("\\ir ../migrations/20261022170000_powerhub_inventory_operation_permissions.sql");
    expect(migration).toContain("powerhub_admin_set_staff_capability_override");
    expect(migration).toContain("powerhub_admin_save_role_policy");
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


  it("wires measured fuel logging to tenant-scoped RPCs and the inventory workspace", () => {
    const panel = read("client/src/components/InventoryFuelConsumptionPanel.tsx");
    const workspace = read("client/src/pages/InventoryWorkspacePage.tsx");
    const router = read("server/powerhub-inventory-router.ts");
    const migration = read("supabase/migrations/20261022210000_powerhub_fuel_consumption_phase_b.sql");
    const appendOnlyAcl = read("supabase/migrations/20261022211000_powerhub_fuel_event_append_only_acl.sql");
    const integration = read("supabase/tests/inventory_purchase_receiving_workflow.sql");
    expect(workspace).toContain('TabsTrigger value="fuel"');
    expect(workspace).toContain("canManageFuelAndConsumption={canManageFuelAndConsumption}");
    expect(workspace).toContain("canViewInventoryReports={canViewInventoryReports}");
    expect(panel).toContain("trpc.powerhub.inventory.recordFuelFill.useMutation");
    expect(panel).toContain("trpc.powerhub.inventory.recordFuelReading.useMutation");
    expect(panel).toContain("trpc.powerhub.inventory.fuelConsumptionReportPeriod.useQuery");
    expect(panel).toContain('periodType: reportPeriodType');
    expect(panel).toContain("تقرير الوقود حسب الفترة المحاسبية");
    expect(panel).toContain("دورة القراءات المعتمدة");
    expect(panel).toContain("trpc.powerhub.inventory.upsertFuelAlertSettings.useMutation");
    expect(panel).toContain("trpc.powerhub.inventory.listFuelAlertSettings.useQuery");
    expect(panel).toContain("trpc.powerhub.inventory.listFuelAlertDispatches.useQuery");
    expect(panel).toContain("إعدادات تنبيهات الوقود");
    expect(panel).toContain("سجل تنبيهات الوقود");
    expect(panel).toContain("recorded_consumption_liters");
    expect(migration).toContain("as recorded_consumption_liters");
    expect(panel).toContain("insufficient_level_readings");
    expect(panel).toContain("actual_consumption_liters == null ? \"غير متاح\"");
    expect(router).toContain("requireSupabaseSiteRole(ctx.user.id, input.siteId, [...roles], \"manageFuelAndConsumption\")");
    expect(router).toContain("powerhub_inventory_record_fuel_fill");
    expect(router).toContain("powerhub_inventory_record_fuel_reading");
    expect(router).toContain("powerhub_inventory_fuel_consumption_report");
    expect(migration).toContain("generator_fuel_events");
    expect(migration).toContain("generator_fuel_readings");
    expect(migration).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(migration).toContain("OPERATING_HOURS_BACKWARDS");
    expect(migration).toContain("measurement_status");
    expect(appendOnlyAcl).toContain("revoke all privileges on table public.generator_fuel_events, public.generator_fuel_readings");
    expect(appendOnlyAcl).toContain("grant select, insert on table public.generator_fuel_events, public.generator_fuel_readings");
    expect(integration).toContain("\\ir ../migrations/20261022210000_powerhub_fuel_consumption_phase_b.sql");
    expect(integration).toContain("\\ir ../migrations/20261022211000_powerhub_fuel_event_append_only_acl.sql");
    expect(integration).toContain("PHASE_B_FUEL_LEDGER_NOT_APPEND_ONLY");
    expect(integration).toContain("PHASE_B_MEASURED_CONSUMPTION_RECONCILIATION_FAILED");
    expect(integration).toContain("PHASE_B_FUEL_FILL_IDEMPOTENCY_FAILED");
    expect(integration).toContain("PHASE_B_FUEL_READING_RPC_ACL_FAILED");
  });


  it("preserves an exact-scope fuel report snapshot when live refresh fails", () => {
    const panel = read("client/src/components/InventoryFuelConsumptionPanel.tsx");
    const cache = read("client/src/lib/offline-operational-report-cache.ts");
    expect(panel).toContain("loadOperationalReportSnapshot(fuelReportCacheInput");
    expect(panel).toContain("const hasAvailableFuelReport = report.data !== undefined || cachedFuelReportForCurrentScope !== null;");
    expect(panel).toContain("report.error && !hasAvailableFuelReport");
    expect(panel).toContain("reportRows.map((row)");
    expect(panel).toContain("هذه لقطة تجميعية وليست إعادة احتساب حيّة");
    expect(cache).toContain("snapshot.key !== makeKey(input)");
    expect(cache).toContain("now - snapshot.savedAt >= OFFLINE_OPERATIONAL_REPORT_TTL_MS");
    expect(cache).toContain("options.accessAllowed === false");
  });
});
