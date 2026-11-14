import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const server=readFileSync("server/powerhub.ts","utf8");
const panel=readFileSync("client/src/components/InventorySupplierPaymentsPanel.tsx","utf8");
const page=readFileSync("client/src/components/finance/FinancialSupplierPaymentCorrectionWorkspace.tsx","utf8");
const begin=server.indexOf("// B4.16: source-specific posted-GL supplier correction");
const end=server.indexOf("// B4.9: site-filtered transfer source discovery",begin);
const routes=server.slice(begin,end);
describe("B4.16 supplier payment documented correction workspace",()=>{
  it("requires all three permissions and binds actor/tenant/site on every route",()=>{
    expect(begin).toBeGreaterThan(0);expect(end).toBeGreaterThan(begin);
    expect((routes.match(/"manageSupplierPayments"/g)||[]).length).toBe(3);
    expect((routes.match(/"reverseSupplierPayments"/g)||[]).length).toBe(3);
    expect((routes.match(/"viewFinancialReports"/g)||[]).length).toBe(3);
    expect(routes).toContain("p_tenant_id:access.tenantId");
    expect(routes).toContain("p_approver_id:ctx.user.id");
    expect(routes).toContain('confirmIndependentReview:z.literal(true)');
    expect(routes).toContain('.eq("tenant_id",access.tenantId).eq("site_id",input.siteId)');
    expect(routes).toContain('.eq("status","pending_review")');
    expect(routes).toContain('return item.tenant_id!==access.tenantId');
  });
  it("does not use offline fallback or expose general GL reversal",()=>{
    expect(page).toContain('getPowerHubConnectivitySnapshot()===true');
    expect(page).toContain("hasAuthoritativeServerRead(readiness)");
    expect(page).toContain("hasAuthoritativeServerRead(pending)");
    expect(page).toContain("confirmIndependentReview:true");
    expect(page).toContain('item.requestedByUserId');
    expect(page).toContain("مرجع سند استرداد المبلغ الفعلي");
    expect(page).toContain("NOT_CERTIFIED");
    expect(page).not.toContain("financialGLReverse");
  });
  it("connects supplier history to on-demand correction, not auto-approval",()=>{
    expect(panel).toContain("FinancialSupplierPaymentCorrectionWorkspace");
    expect(panel).toContain("تصحيح القيد المحاسبي للمورد");
    expect(panel).toContain("canReverseSupplierPayments");
    expect(panel).toContain("canViewSupplierCorrectionFinancialReports");
    expect(panel).toContain("canManageSupplierPayments&&canReverseSupplierPayments&&canViewSupplierCorrectionFinancialReports");
    const inventoryPage=readFileSync("client/src/pages/InventoryWorkspacePage.tsx","utf8");
    expect(inventoryPage).toContain("canViewSupplierCorrectionFinancialReports={canViewSupplierCorrectionFinancialReports}");
  });
});
