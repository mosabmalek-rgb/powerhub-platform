import { describe, expect, it } from "vitest";
import { buildFinancialOverview } from "./financial-overview-utils";

describe("buildFinancialOverview", () => {
  it("يجمع الفوترة والتحصيل والمتأخرات وأولوية الديون حسب الفرع", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const overview = buildFinancialOverview({
      now,
      branches: [{ id: 1, name: "الفرع الرئيسي", activeSubscribers: 12 }, { id: 2, name: "فرع السوق", activeSubscribers: 8 }],
      invoices: [
        { siteId: 1, subscriberId: 1, subscriberName: "أحمد", subscriberNo: "PH-1", invoiceNo: "INV-1", issueDate: new Date("2026-08-21T08:00:00.000Z"), dueDate: new Date("2026-08-10T00:00:00.000Z"), totalAmount: 100, paidAmount: 30, balanceDue: 70, status: "partially_paid" },
        { siteId: 2, subscriberId: 2, subscriberName: "سارة", subscriberNo: "PH-2", invoiceNo: "INV-2", issueDate: new Date("2026-08-05T08:00:00.000Z"), dueDate: new Date("2026-08-28T00:00:00.000Z"), totalAmount: 80, paidAmount: 0, balanceDue: 80, status: "issued" },
      ],
      payments: [{ siteId: 1, subscriberId: 1, amount: 30, status: "completed", paidAt: new Date("2026-08-21T10:00:00.000Z") }],
      expenses: [{ siteId: 1, amount: 10, occurredAt: new Date("2026-08-12T10:00:00.000Z") }],
    });

    expect(overview.today).toMatchObject({ invoiced: 100, collected: 30, collectionRate: 30 });
    expect(overview.month).toMatchObject({ invoiced: 180, collected: 30, expenses: 10, netCash: 20 });
    expect(overview.outstanding).toMatchObject({ total: 150, overdue: 70, partialInvoices: 1, accountCount: 2 });
    expect(overview.branchSummaries[0]).toMatchObject({ name: "فرع السوق", outstanding: 80, collectionRate: 0 });
    expect(overview.topDebtors[0]).toMatchObject({ subscriber: "أحمد", outstanding: 70, isOverdue: true, ageDays: 11, lastPaymentAt: "2026-08-21T10:00:00.000Z" });
  });
});
