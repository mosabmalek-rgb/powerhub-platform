import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const router = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");
const revisions = readFileSync(resolve(process.cwd(), "server/dashboard-kpi-revisions.ts"), "utf8");

describe("dashboard Delta revision contract", () => {
  it("exposes only an authorized tenant/site-scoped fingerprint, never operational rows", () => {
    const start = router.indexOf("deltaRevision: protectedProcedure");
    const end = router.indexOf("financialTrend: protectedProcedure", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const procedure = router.slice(start, end);

    expect(procedure).toContain("requireSupabaseSiteRole");
    expect(procedure).toContain("requireSupabaseAllBranchesRole");
    expect(procedure).toContain('.eq("tenant_id", access.tenantId)');
    expect(procedure).toContain('.in("entity_type", entityTypes)');
    expect(procedure).toContain('query = query.eq("site_id", input.siteId)');
    expect(procedure).toContain("DASHBOARD_KPI_REVISION_ENTITIES");
    expect(procedure).toContain("buildDashboardKpiRevisions(data ?? [])");
    expect(procedure).not.toContain('.select("*")');
    expect(procedure).not.toContain("row_data");
  });

  it("uses one central exact dependency registry for all dashboard KPI fingerprints", () => {
    expect(router).toContain('from "./dashboard-kpi-revisions"');
    for (const key of [
      "activeSubscribers", "generatorStatus", "periodInvoiced", "periodCollected",
      "collectionRate", "periodOverdue", "expenses", "netCash", "currentArrears",
      "financialTrend", "companyBalances",
    ]) expect(revisions).toContain(`${key}:`);
    expect(revisions).not.toContain("operatingProfit:");
    expect(revisions).not.toContain("operationalStatus:");
  });

  it("keeps company-account balance revisions separate from cash flow and financial overview", () => {
    expect(revisions).toContain('companyBalances: ["company_accounts", "company_accounts_all"]');
    expect(revisions).toContain('netCash: ["payments", "expenses"]');
    expect(revisions).toContain('financialTrend: ["sites", "subscribers", "invoices", "payments", "expenses"]');
  });

  it("includes time buckets for deadline- and month-dependent KPIs even when no row is written", () => {
    expect(revisions).toContain('"periodOverdue"');
    expect(revisions).toContain('"currentArrears"');
    expect(revisions).toContain('"financialTrend"');
    expect(revisions).toContain('now.toISOString().slice(0, 16)');
    expect(revisions).toContain('dashboardKpiUtcMonthKey');
  });
});
