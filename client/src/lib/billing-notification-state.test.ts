import { describe, expect, it } from "vitest";
import { groupInvoiceSmsStatuses, invoiceSmsStatusLabel, isInvoiceSmsEligibleForNewQueue } from "./billing-notification-state";

describe("invoice SMS queue state", () => {
  const rows = [
    { notification: { invoiceId: 11, status: "failed", scheduledAt: null } },
    { notification: { invoiceId: 12, status: "pending", scheduledAt: new Date("2099-01-01T00:00:00Z") } },
    { notification: { invoiceId: 13, status: "needs_review", scheduledAt: null } },
    { notification: { invoiceId: 14, status: "submitted", scheduledAt: null } },
    { notification: { invoiceId: null, status: "pending", scheduledAt: null } },
  ];

  it("groups only invoice-bound SMS records by invoice ID", () => {
    const grouped = groupInvoiceSmsStatuses(rows);
    expect(grouped.get(11)).toEqual(["failed"]);
    expect(grouped.get(12)).toEqual(["pending"]);
    expect(grouped.get(13)).toEqual(["needs_review"]);
    expect(grouped.get(14)).toEqual(["submitted"]);
    expect(grouped.size).toBe(4);
  });

  it("never labels an invoice as unsent until its SMS query succeeded", () => {
    expect(isInvoiceSmsEligibleForNewQueue([], "loading")).toBe(false);
    expect(isInvoiceSmsEligibleForNewQueue([], "error")).toBe(false);
    expect(isInvoiceSmsEligibleForNewQueue([], "ready")).toBe(true);
  });

  it.each(["pending", "processing", "submitted", "delivered", "read", "failed", "needs_review"])(
    "blocks a new queue operation when an existing message is %s",
    (status) => expect(isInvoiceSmsEligibleForNewQueue([status], "ready")).toBe(false),
  );

  it("shows retry/review status instead of calling those invoices unsent", () => {
    expect(invoiceSmsStatusLabel(["failed"], "ready")).toBe("فشل");
    expect(invoiceSmsStatusLabel(["needs_review"], "ready")).toBe("تحتاج مراجعة");
    expect(invoiceSmsStatusLabel(["pending"], "ready")).toBe("في قائمة الانتظار");
    expect(invoiceSmsStatusLabel(["submitted"], "ready")).toBe("مرسل");
    expect(invoiceSmsStatusLabel([], "loading")).toBe("جارٍ التحقق");
    expect(invoiceSmsStatusLabel([], "error")).toBe("تعذر التحقق");
  });

  it("gives needs-review precedence when multiple statuses exist", () => {
    expect(invoiceSmsStatusLabel(["failed", "needs_review"], "ready")).toBe("تحتاج مراجعة");
  });
});
