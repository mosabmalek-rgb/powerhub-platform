import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const router = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");
const home = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");
const reports = readFileSync(resolve(process.cwd(), "client/src/pages/ReportsPage.tsx"), "utf8");
const dashboardRevisions = readFileSync(resolve(process.cwd(), "server/dashboard-kpi-revisions.ts"), "utf8");

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
    expect(financial).toContain('input.metric === "expenses" || input.metric === "netCash"');
    expect(financial).toContain('input.metric === "netCash"');
    expect(financial).toContain('input.metric === "currentArrears"');
    expect(financial).toContain('buildDashboardFinancialKpi');

  });

  it("refreshes financial reports from their independent invoice/payment/expense revision", () => {
    expect(dashboardRevisions).toContain('financialReport: ["sites", "subscribers", "invoices", "payments", "expenses"]');
    expect(reports).toContain("trpc.powerhub.dashboard.deltaRevision.useQuery(");
    expect(reports).toContain("canReadFinancialReport && !reportAccessDenied");
    expect(reports).toContain("refetchInterval: false");
    expect(reports).toContain("useAdaptiveDeltaRefresh({");
    expect(reports).toContain("checkFinancialReportRevision");
    expect(reports).toContain("refetchOnReconnect: false");
    expect(reports).toContain("comparisonBranchRevisionEnabled = comparisonBranchEnabled && canReadFinancialReport");
    expect(reports).toContain("revisions?.financialReport");
    expect(reports).toContain("lastReportRevisions.current.get(key)");
    expect(reports).toContain("lastReportRevisions.current.set(key, revision)");
    expect(reports).toContain("void activeQuery.refetch()");
    expect(reports).toContain("if (comparisonMode === \"period\") void comparisonActiveQuery.refetch()");
    expect(reports).toContain("comparisonBranchRevisionQuery");
    expect(reports).toContain("void comparisonBranchQuery.refetch()");
    expect(reports).toContain("hasAuthoritativeServerRead(activeQuery)");
    expect(reports).toContain("createOfflineReportSnapshotPayload(liveReport)");
    expect(reports).not.toContain("row_data");
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
    expect(home).toContain("todayInvoicedKpiQuery.refetch()");
    expect(home).toContain("todayCollectedKpiQuery.refetch()");
    expect(home).toContain("todayCollectionRateKpiQuery.refetch()");
    expect(home).toContain("monthCollectionRateKpiQuery.refetch()");
    expect(home).toContain('changed.has("financialTrend")');
    expect(home).toContain('changed.has("expenses")');
    expect(home).toContain('changed.has("netCash")');
    expect(home).toContain('changed.has("currentArrears")');
    expect(home).toContain("expensesKpiQuery.refetch()");
    expect(home).toContain("netCashKpiQuery.refetch()");
    expect(home).toContain("currentArrearsKpiQuery.refetch()");
    expect(home).not.toContain('changed.has("financialOverview")');
  });

  it("retains independent revision baselines across branch/all-branch scope switches", () => {
    const start = home.indexOf("const lastDashboardRevisions = useRef<Map<string, Record<string, string>>>");
    const comparison = home.indexOf("previousRevisions[metric]", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(comparison).toBeGreaterThan(start);
    const effect = home.slice(start, comparison + "previousRevisions[metric]".length);
    expect(effect).toContain("lastDashboardRevisions.current.get(key)");
    expect(effect).toContain("lastDashboardRevisions.current.set(key, revisions)");
    expect(effect).toContain("while (lastDashboardRevisions.current.size > 32)");
    expect(effect).toContain("previousRevisions[metric]");
    expect(effect).not.toContain("previous.key !== key");
  });

  it("keeps daily/monthly KPI refresh independent from the selected period filter", () => {
    expect(home).toContain("const periodKpiBaseEnabled =");
    expect(home).toContain("const periodKpiEnabled = periodKpiBaseEnabled && dashboardPeriod.isReady");
    expect(home).toContain("enabled: periodKpiBaseEnabled");
    expect(home).toContain("todayInvoicedKpiQuery.refetch()");
    expect(home).toContain("todayCollectedKpiQuery.refetch()");
    expect(home).toContain("monthCollectionRateKpiQuery.refetch()");
  });


  it("hides denied snapshots and purges only the affected dashboard scope", () => {
    expect(home).toContain("isExplicitAuthorizationDenial(accessQuery.error)");
    expect(home).toContain("const sitesAccessDenied = isExplicitAuthorizationDenial(sitesQuery.error)");
    expect(home).toContain("const dashboardScopeDenied = sitesAccessDenied || isExplicitAuthorizationDenial(accessQuery.error)");
    expect(home).toContain("accessQuery.data?.role === \"owner\" && !dashboardScopeDenied");
    expect(home).toContain("selectedScope === \"all\" && !dashboardScopeDenied");

    expect(home).toContain("const dashboardRevisionDenied = dashboardScopeDenied || isExplicitAuthorizationDenial(dashboardRevisionQuery.error)");
    expect(home).not.toContain("const dashboardRevisionDenied = isExplicitAuthorizationDenial(dashboardRevisionQuery.error)");
    expect(home).toContain("dashboardRevisionQuery.isError");
    expect(home).toContain("تعذر التحقق من حداثة لقطة لوحة التحكم. نعرض آخر مؤشرات محفوظة");
    expect(home).toContain("isExplicitAuthorizationDenial(query.error)");
    expect(home).toContain("clearOfflineDashboardSnapshotCacheForSite(String(user.id), siteId, [...denied])");
    expect(home).toContain("isExplicitAuthorizationDenial(summaryQuery.error)");
    expect(home).toContain("operationalSummaryDenied");
  });
});