import { describe, expect, it } from "vitest";
import { buildFinancialOverview, buildFinancialTrendSeries } from "./financial-overview-utils";

describe("buildFinancialOverview", () => {
  it("يجمع الفوترة والتحصيل والمتأخرات وأولوية الديون حسب الفرع", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const overview = buildFinancialOverview({
      now,
      branches: [{ id: 1, name: "الفرع الرئيسي", activeSubscribers: 12 }, { id: 2, name: "فرع السوق", activeSubscribers: 8 }],
      invoices: [
        { id: 101, siteId: 1, subscriberId: 1, subscriberName: "أحمد", subscriberNo: "PH-1", invoiceNo: "INV-1", issueDate: new Date("2026-08-21T08:00:00.000Z"), dueDate: new Date("2026-08-10T00:00:00.000Z"), totalAmount: 100, paidAmount: 30, balanceDue: 70, status: "partially_paid" },
        { id: 102, siteId: 2, subscriberId: 2, subscriberName: "سارة", subscriberNo: "PH-2", invoiceNo: "INV-2", issueDate: new Date("2026-08-05T08:00:00.000Z"), dueDate: new Date("2026-08-28T00:00:00.000Z"), totalAmount: 80, paidAmount: 0, balanceDue: 80, status: "issued" },
      ],
      payments: [{ siteId: 1, subscriberId: 1, amount: 30, status: "completed", paidAt: new Date("2026-08-21T10:00:00.000Z") }],
      expenses: [{ siteId: 1, amount: 10, occurredAt: new Date("2026-08-12T10:00:00.000Z") }],
    });

    expect(overview.today).toMatchObject({ invoiced: 100, collected: 30, collectionRate: 30 });
    expect(overview.month).toMatchObject({ invoiced: 180, collected: 30, expenses: 10, netCash: 20 });
    expect(overview.outstanding).toMatchObject({ total: 150, overdue: 70, partialInvoices: 1, accountCount: 2 });
    expect(overview.branchSummaries[0]).toMatchObject({ name: "فرع السوق", outstanding: 80, collectionRate: 0 });
    expect(overview.topDebtors[0]).toMatchObject({ subscriber: "أحمد", outstanding: 70, isOverdue: true, ageDays: 11, lastPaymentAt: "2026-08-21T10:00:00.000Z", invoiceId: 101, invoiceNo: "INV-1" });
    expect(overview.outstandingInvoices).toHaveLength(2);
    expect(overview.outstandingInvoices[0]).toMatchObject({ invoiceId: 101, invoiceNo: "INV-1", outstanding: 70, isOverdue: true, partialInvoices: 1 });
    expect(overview.outstandingInvoices[1]).toMatchObject({ invoiceId: 102, invoiceNo: "INV-2", outstanding: 80, isOverdue: false, partialInvoices: 0 });
  });

  it("sums currency amounts exactly in integer minor units", () => {
    const overview = buildFinancialOverview({
      now: new Date("2026-08-21T12:00:00.000Z"),
      branches: [{ id: 1, name: "الفرع", activeSubscribers: 1 }],
      invoices: [
        { id: 1, siteId: 1, subscriberId: 1, subscriberName: "أ", subscriberNo: "1", invoiceNo: "I-1", issueDate: new Date("2026-08-21T08:00:00.000Z"), dueDate: new Date("2026-08-30T00:00:00.000Z"), totalAmount: "0.10", paidAmount: "0", balanceDue: "0.10", status: "issued" },
        { id: 2, siteId: 1, subscriberId: 2, subscriberName: "ب", subscriberNo: "2", invoiceNo: "I-2", issueDate: new Date("2026-08-21T09:00:00.000Z"), dueDate: new Date("2026-08-30T00:00:00.000Z"), totalAmount: "0.20", paidAmount: "0", balanceDue: "0.20", status: "issued" },
      ],
      payments: [
        { siteId: 1, subscriberId: 1, amount: "0.10", status: "completed", paidAt: new Date("2026-08-21T10:00:00.000Z") },
        { siteId: 1, subscriberId: 2, amount: "0.20", status: "completed", paidAt: new Date("2026-08-21T11:00:00.000Z") },
      ],
      expenses: [{ siteId: 1, amount: "0.05", occurredAt: new Date("2026-08-21T12:00:00.000Z") }],
    });
    expect(overview.today).toMatchObject({ invoiced: 0.3, collected: 0.3, collectionRate: 100 });
    expect(overview.month).toMatchObject({ invoiced: 0.3, collected: 0.3, expenses: 0.05, netCash: 0.25 });
    expect(overview.outstanding.total).toBe(0.3);
    expect(overview.branchSummaries[0]).toMatchObject({ invoiced: 0.3, collected: 0.3, outstanding: 0.3 });
    expect(overview.trend.find((row) => row.date === "2026-08-21")).toMatchObject({
      invoiced: 0.3, collected: 0.3, expenses: 0.05, netCash: 0.25,
    });
  });

});

describe("buildFinancialTrendSeries", () => {
  it("ينشئ سلسلة يومية مكتملة ويجمع الفوترة والتحصيل والمصروفات وصافي النقد", () => {
    const series = buildFinancialTrendSeries({
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-04T00:00:00.000Z"),
      invoices: [
        { id: 1, siteId: 1, subscriberId: 1, subscriberName: "أ", subscriberNo: "1", invoiceNo: "I-1", issueDate: new Date("2026-08-01T10:00:00.000Z"), dueDate: new Date("2026-08-10T00:00:00.000Z"), totalAmount: 100, paidAmount: 0, balanceDue: 100, status: "issued" },
        { id: 2, siteId: 1, subscriberId: 2, subscriberName: "ب", subscriberNo: "2", invoiceNo: "I-2", issueDate: new Date("2026-08-02T10:00:00.000Z"), dueDate: new Date("2026-08-10T00:00:00.000Z"), totalAmount: 50, paidAmount: 0, balanceDue: 50, status: "cancelled" },
      ],
      payments: [
        { siteId: 1, subscriberId: 1, amount: 40, status: "completed", paidAt: new Date("2026-08-02T12:00:00.000Z") },
        { siteId: 1, subscriberId: 1, amount: 9, status: "pending", paidAt: new Date("2026-08-03T12:00:00.000Z") },
      ],
      expenses: [{ siteId: 1, amount: 15, occurredAt: new Date("2026-08-03T08:00:00.000Z") }],
    });

    expect(series).toEqual([
      { date: "2026-08-01", invoiced: 100, collected: 0, expenses: 0, netCash: 0 },
      { date: "2026-08-02", invoiced: 0, collected: 40, expenses: 0, netCash: 40 },
      { date: "2026-08-03", invoiced: 0, collected: 0, expenses: 15, netCash: -15 },
    ]);
  });

  it("يرفض الفترة العكسية", () => {
    expect(() => buildFinancialTrendSeries({
      from: new Date("2026-08-04T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
      invoices: [],
      payments: [],
      expenses: [],
    })).toThrow("الفترة الزمنية غير صالحة");
  });
});
