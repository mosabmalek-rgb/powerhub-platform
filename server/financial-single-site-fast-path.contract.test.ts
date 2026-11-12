import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const router = readFileSync("server/powerhub.ts", "utf8");
const panel = readFileSync("client/src/components/finance/FinancialGLAuditPanel.tsx", "utf8");

describe("single-site finance first, multi-site isolation retained", () => {
  it("counts only tenant-owned active sites after authorized site membership", () => {
    const start = router.indexOf("financialGLSiteScope: protectedProcedure.input(siteScoped)");
    const end = router.indexOf("financialGLTenantRollup:", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const route = router.slice(start, end);
    expect(route).toContain('requireSupabaseSiteRole(ctx.user.id,input.siteId');
    expect(route).toContain('"viewFinancialReports"');
    expect(route).toContain('.eq("tenant_id",access.tenantId)');
    expect(route).toContain('.eq("status","active")');
    expect(route).toContain('typeof count!=="number"');
    expect(route).toContain('data.length!==count');
    expect(route).toContain('data.some(site=>Number(site.id)===input.siteId)');
    expect(route).toContain('hasMultipleActiveSites:count>1');
  });

  it("does not fetch consolidated statements or render multi-site actions for one site", () => {
    expect(panel).toContain("financialGLSiteScope.useQuery({siteId}");
    expect(panel).toContain("siteScope.isSuccess &&");
    expect(panel).toContain("siteScope.data?.siteId===siteId");
    expect(panel).toContain("enabled:enabled && hasMultipleSites && showB3");
    expect(panel).toContain("{hasMultipleSites ? <>");
    expect(panel).toContain("<FinancialCentralAllocationWorkspace");
    expect(panel).toContain("<FinancialInterSiteTransferWorkspace");
    expect(panel).toContain("siteScope.data?.activeSiteCount===1");
  });

  it("fails closed for unknown scope, without disabling site-only audits", () => {
    expect(panel).toContain("siteScope.isError");
    expect(panel).toContain("حُجبت أدوات التحويل والتجميع");
    expect(panel).toContain("financialGLSubledgerReconciliation.useQuery");
    expect(panel).toContain("financialGLCompanyMovementAudit.useQuery");
    expect(panel).toContain("financialGLSiteStatements.useQuery");
    expect(panel).toContain("NOT_CERTIFIED");
    expect(panel).not.toContain("supabaseAdmin()");
  });
});
