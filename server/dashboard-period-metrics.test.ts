import { describe, expect, it } from "vitest";
import { buildDashboardPeriodMetrics } from "./dashboard-period-metrics";

describe("buildDashboardPeriodMetrics", () => {
  it("calculates date-scoped billing, completed collections and currently overdue balances", () => {
    const now = new Date("2026-10-20T12:00:00.000Z");
    const invoices = [
      { id: 1, siteId: 10, siteName: "الرئيسي", subscriberId: 101, subscriberName: "أحمد", subscriberNo: "P-101", invoiceNo: "I-1", issueDate: new Date("2026-10-01T08:00:00.000Z"), dueDate: new Date("2026-10-10T00:00:00.000Z"), totalAmount: 100, paidAmount: 40, balanceDue: 60, status: "partially_paid" },
      { id: 2, siteId: 10, siteName: "الرئيسي", subscriberId: 102, subscriberName: "سارة", subscriberNo: "P-102", invoiceNo: "I-2", issueDate: new Date("2026-10-02T08:00:00.000Z"), dueDate: new Date("2026-10-30T00:00:00.000Z"), totalAmount: 80, paidAmount: 0, balanceDue: 80, status: "issued" },
      { id: 3, siteId: 10, siteName: "الرئيسي", subscriberId: 103, subscriberName: "مسودة", subscriberNo: "P-103", invoiceNo: "I-3", issueDate: new Date("2026-10-03T08:00:00.000Z"), dueDate: new Date("2026-10-15T00:00:00.000Z"), totalAmount: 500, paidAmount: 0, balanceDue: 500, status: "draft" },
      { id: 4, siteId: 10, siteName: "الرئيسي", subscriberId: 104, subscriberName: "ملغاة", subscriberNo: "P-104", invoiceNo: "I-4", issueDate: new Date("2026-10-04T08:00:00.000Z"), dueDate: new Date("2026-10-15T00:00:00.000Z"), totalAmount: 600, paidAmount: 0, balanceDue: 600, status: "cancelled" },
    ];
    const result = buildDashboardPeriodMetrics({
      scope: "branch",
      startDate: "2026-10-01",
      endDate: "2026-10-31",
      invoices,
      payments: [{ status: "completed", amount: "30.50" }, { status: "pending", amount: 999 }],
      now,
    });

    expect(result.summary).toEqual({
      invoiced: 180,
      collected: 30.5,
      collectionRate: 30.5 / 180 * 100,
      outstanding: 140,
      overdue: 60,
      overdueInvoiceCount: 1,
      overdueSubscriberCount: 1,
    });
    expect(result.outstandingInvoices).toHaveLength(2);
    expect(result.outstandingInvoices[0]).toMatchObject({ invoiceId: 1, subscriber: "أحمد", outstanding: 60, issueDate: "2026-10-01T08:00:00.000Z", isOverdue: true, partialInvoices: 1, ageDays: 10 });
  });

  it("returns zeroes for an empty period and rejects reversed date bounds", () => {
    const result = buildDashboardPeriodMetrics({ scope: "branch", startDate: "2026-09-01", endDate: "2026-09-30", invoices: [], payments: [], now: new Date("2026-10-20T12:00:00.000Z") });
    expect(result.summary).toMatchObject({ invoiced: 0, collected: 0, collectionRate: 0, outstanding: 0, overdue: 0 });
    expect(() => buildDashboardPeriodMetrics({ scope: "branch", startDate: "2026-10-31", endDate: "2026-10-01", invoices: [], payments: [] })).toThrow("الفترة الزمنية غير صالحة");
  });
});
