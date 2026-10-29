import { describe, expect, it } from "vitest";

describe("مفاتيح لقطات التقارير دون اتصال", () => {
  it("يعزل منطق المفتاح بحسب المستخدم والفرع والنطاق الزمني", async () => {
    const module = await import("./offline-report-cache");
    expect(typeof module.loadReportSnapshot).toBe("function");
    expect(typeof module.saveReportSnapshot).toBe("function");
  });
});


describe("نطاق صلاحية لقطات التقارير المالية المحلية", () => {
  const scope = {
    userId: 11,
    siteId: 7,
    scope: "branch" as const,
    startDate: "2026-10-01",
    endDate: "2026-10-29",
  };
  const snapshot = {
    ...scope,
    key: "11:7:branch:2026-10-01:2026-10-29",
    report: { summary: { invoiced: 1200 } },
    savedAt: 10_000,
  };

  it("accepts only a fresh snapshot matching the active user, branch, scope and date range", async () => {
    const { getUsableReportSnapshot } = await import("./offline-report-cache");
    expect(getUsableReportSnapshot(snapshot, scope, { now: 11_000 })).toEqual(snapshot);
    expect(getUsableReportSnapshot(snapshot, { ...scope, userId: 12 }, { now: 11_000 })).toBeUndefined();
    expect(getUsableReportSnapshot(snapshot, { ...scope, siteId: 8 }, { now: 11_000 })).toBeUndefined();
    expect(getUsableReportSnapshot(snapshot, { ...scope, scope: "all" }, { now: 11_000 })).toBeUndefined();
    expect(getUsableReportSnapshot(snapshot, { ...scope, startDate: "2026-09-01" }, { now: 11_000 })).toBeUndefined();
    expect(getUsableReportSnapshot(snapshot, { ...scope, endDate: "2026-10-28" }, { now: 11_000 })).toBeUndefined();
  });

  it("does not return a stale, future-dated or unauthorized report snapshot", async () => {
    const { getUsableReportSnapshot, OFFLINE_REPORT_CACHE_TTL_MS } = await import("./offline-report-cache");
    expect(getUsableReportSnapshot(snapshot, scope, { now: snapshot.savedAt + OFFLINE_REPORT_CACHE_TTL_MS })).toBeUndefined();
    expect(getUsableReportSnapshot({ ...snapshot, savedAt: 20_000 }, scope, { now: 11_000 })).toBeUndefined();
    expect(getUsableReportSnapshot(snapshot, scope, { now: 11_000, authorizationDenied: true })).toBeUndefined();
    expect(getUsableReportSnapshot(snapshot, scope, { now: 11_000, accessAllowed: false })).toBeUndefined();
  });
});


describe("تنقية محتوى التقرير قبل التخزين المحلي", () => {
  it("persists only aggregate fields and omits debtor, collector and payment detail", async () => {
    const { createOfflineReportSnapshotPayload } = await import("./offline-report-cache");
    const safe = createOfflineReportSnapshotPayload({
      range: { startDate: "2026-10-01", endDate: "2026-10-29" },
      summary: { invoiced: 1200, collected: 800, outstanding: 400 },
      scope: { branchCount: 1 },
      branchSummaries: [{ siteId: 7, branchName: "فرع الاختبار", invoiced: 1200 }],
      topDebtors: [{ subscriber: "مشترك حساس", invoiceNo: "INV-1", balanceDue: 400 }],
      collectors: [{ name: "اسم موظف", count: 2, amount: 800 }],
      paymentDetails: [{ paymentNo: "PAY-1", amount: 800 }],
    }) as Record<string, unknown>;
    expect(safe).toEqual({
      range: { startDate: "2026-10-01", endDate: "2026-10-29" },
      summary: { invoiced: 1200, collected: 800, outstanding: 400 },
      scope: { branchCount: 1 },
      branchSummaries: [{ siteId: 7, branchName: "فرع الاختبار", invoiced: 1200 }],
    });
    expect(safe).not.toHaveProperty("topDebtors");
    expect(safe).not.toHaveProperty("collectors");
    expect(safe).not.toHaveProperty("paymentDetails");
  });
});
