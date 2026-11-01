import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const router = read("server/powerhub.ts");
const reportReads = read("server/powerhub-supabase.ts");
const metrics = read("server/dashboard-period-metrics.ts");
const hook = read("client/src/hooks/useDashboardKpiPeriod.ts");
const filter = read("client/src/components/DashboardKpiPeriodFilter.tsx");
const home = read("client/src/pages/Home.tsx");
const subscribers = read("client/src/pages/NetworkDirectoryPage.tsx");

describe("billing-cycle dashboard KPI and arrears handoff", () => {
  it("uses authorized server-side reports and the canonical billing-cycle boundaries", () => {
    expect(router).toContain('periodMetrics: protectedProcedure.input(z.object({');
    expect(router).toContain('boundsAt: protectedProcedure.input(siteScoped.extend({');
    expect(router).toContain('requireSupabaseSiteRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant", "viewer"])');
    expect(router).toContain("listSupabaseReportInvoices({ tenantId, siteIds, start, endExclusive, summaryOnly: !input.includeDetails })");
    expect(router).toContain("listSupabaseReportPayments({ tenantId, siteIds, start, endExclusive, summaryOnly: !input.includeDetails })");
    expect(router).toContain("includeDetails: z.boolean().default(true)");
    expect(router).toContain("const subscriberRows = input.includeDetails");
    expect(reportReads).toContain('.select(input.summaryOnly');
    expect(reportReads).toContain('? "id, site_id, subscriber_id, issue_date, due_date, total_amount, balance_due, status"');
    expect(reportReads).toContain('? "id, site_id, subscriber_id, amount, status, paid_at"');
    expect(router).toContain("paymentDocumentationGazaDateBoundary(input.startDate)");
    expect(metrics).toContain('invoice.status !== "cancelled" && invoice.status !== "draft"');
    expect(metrics).toContain('payment.status === "completed"');
    expect(metrics).toContain("overdueSubscriberCount");
  });

  it("defaults to the current billing cycle and exposes the requested four period presets", () => {
    expect(hook).toContain('useState<DashboardKpiPeriodPreset>(initial?.preset ?? "current_cycle")');
    expect(hook).toContain('current_cycle: "الدورة الحالية"');
    expect(hook).toContain('previous_cycle: "الدورة السابقة"');
    expect(hook).toContain('last_month: "آخر شهر"');
    expect(hook).toContain('custom: "مخصص"');
    expect(filter).toContain("dashboardKpiPeriodLabels[preset]");
    expect(filter).toContain('type="date"');
  });

  it("binds the first four dashboard cards to the selected range and hands the same range to arrears", () => {
    expect(home).toContain('metric: "periodInvoiced"');
    expect(home).toContain('metric: "periodCollected"');
    expect(home).toContain('metric: "collectionRate"');
    expect(home).toContain('metric: "periodOverdue"');
    expect(home).toContain("enabled: periodKpiEnabled");
    expect(home).toContain("includeDetails: false");
    expect(home).toContain("value={periodKpiNumber(periodInvoicedKpiQuery)}");
    expect(home).toContain("value={periodKpiNumber(periodCollectedKpiQuery)}");
    expect(home).toContain("value={periodKpiRatio(collectionRateKpiQuery)}");
    expect(home).toContain("value={periodKpiNumber(periodOverdueKpiQuery)}");
    expect(home).toContain('debtorPeriod: dashboardPeriod.preset');
    expect(home).toContain('debtorStatus: "overdue"');
    expect(home).toContain('debtorFocus: "1"');
    expect(home).toContain("/subscribers?");
  });

  it("keeps the filter and exports in the subscribers arrears list with non-overlapping table columns", () => {
    expect(subscribers).toContain("initialPeriod={initialDebtorPeriod}");
    expect(subscribers).toContain("periodMetricsQuery.data?.outstandingInvoices");
    expect(subscribers).toContain("includeDetails: true");
    expect(subscribers).toContain("<DashboardKpiPeriodFilter");
    expect(subscribers).toContain("downloadReportHtmlAsPdf");
    expect(subscribers).toContain("loadExcelJS");
    expect(subscribers).toContain("table-fixed border-collapse");
    expect(subscribers).toContain("<colgroup>");
    expect(subscribers).toContain('id="subscriber-arrears"');
  });
});
