import { describe, expect, it } from "vitest";
import { invoiceStatusMeta, outstandingInvoices, summarizeOutstandingInvoices } from "./invoice-collection-presentation";

describe("invoice collection presentation", () => {
  const invoices = [
    { id: 1, status: "paid", totalAmount: "100", paidAmount: "100", balanceDue: "0" },
    { id: 2, status: "partially_paid", totalAmount: "100", paidAmount: "40", balanceDue: "60" },
    { id: 3, status: "issued", totalAmount: "80", paidAmount: "0", balanceDue: "80" },
    { id: 4, status: "cancelled", totalAmount: "20", paidAmount: "0", balanceDue: "20" },
  ];

  it("distinguishes complete payment from partial payment", () => {
    expect(invoiceStatusMeta("paid")).toEqual({ label: "مدفوعة بالكامل", tone: "emerald" });
    expect(invoiceStatusMeta("partially_paid")).toEqual({ label: "مدفوعة جزئياً", tone: "amber" });
  });

  it("summarizes only invoices that still require collection", () => {
    expect(outstandingInvoices(invoices).map((invoice) => invoice.id)).toEqual([2, 3]);
    expect(summarizeOutstandingInvoices(invoices)).toEqual({ count: 2, outstanding: 140, partiallyPaidCount: 1, unpaidCount: 1 });
  });
});
