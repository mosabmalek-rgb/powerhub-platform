import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const router = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");
const home = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");

describe("independent dashboard KPI snapshots", () => {
  it("exposes a dedicated server snapshot for each period KPI", () => {
    const start = router.indexOf("periodKpi: protectedProcedure");
    const end = router.indexOf("financialOverview: protectedProcedure", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const procedure = router.slice(start, end);

    for (const metric of ["periodInvoiced", "periodCollected", "collectionRate", "periodOverdue"]) {
      expect(procedure).toContain(`"${metric}"`);
    }
    expect(procedure).toContain('const needsInvoices = input.metric !== "periodCollected"');
    expect(procedure).toContain('const needsPayments = input.metric === "periodCollected" || input.metric === "collectionRate"');
    expect(procedure).toContain("listSupabaseReportInvoices");
    expect(procedure).toContain("listSupabaseReportPayments");
    expect(procedure).toContain("requireSupabaseSiteRole");
    expect(procedure).toContain("requireSupabaseAllBranchesRole");
    expect(procedure).toContain("tenantId, siteIds, start, endExclusive");
    expect(procedure).toContain("includeDetails: false");
    expect(procedure).toContain("auxiliaryCount");
    const financial = router.slice(router.indexOf("financialKpi: protectedProcedure"), router.indexOf("financialOverview: protectedProcedure", router.indexOf("financialKpi: protectedProcedure")));
    expect(financial).toContain('metric: z.enum(["expenses", "netCash", "currentArrears"])');
    expect(financial).toContain('input.metric === "netCash"');
    expect(financial).toContain('input.metric === "currentArrears"');
    expect(financial).toContain('.eq("tenant_id", tenantId)');
    expect(financial).toContain('.in("site_id", siteIds)');
  });

  it("gives active subscribers a standalone tenant/site-authorized count query", () => {
    const start = router.indexOf("activeSubscribersKpi: protectedProcedure");
    const end = router.indexOf("periodKpi: protectedProcedure", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const procedure = router.slice(start, end);
    expect(procedure).toContain("requireSupabaseSiteRole");
    expect(procedure).toContain("requireSupabaseAllBranchesRole");
    expect(procedure).toContain('.eq("tenant_id", tenantId)');
    expect(procedure).toContain('.in("site_id", siteIds)');
    expect(procedure).toContain('.eq("service_status", "active")');
    expect(procedure).toContain('{ count: "exact", head: true }');
  });

  it("binds each period KPI revision to only its own query refetch", () => {
    for (const [metric, query] of [
      ["periodInvoiced", "periodInvoicedKpiQuery"],
      ["periodCollected", "periodCollectedKpiQuery"],
      ["collectionRate", "collectionRateKpiQuery"],
      ["periodOverdue", "periodOverdueKpiQuery"],
    ] as const) {
      expect(home).toContain(`metric: "${metric}"`);
      expect(home).toContain(`changed.has("${metric}")`);
      expect(home).toContain(`${query}.refetch()`);
    }
    expect(home).toContain('changed.has("activeSubscribers")');
    expect(home).toContain("activeSubscribersKpiQuery.refetch()");
    expect(home).not.toContain("periodMetricsQuery");
  });
});
