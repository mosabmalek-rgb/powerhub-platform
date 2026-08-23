import { describe, expect, it } from "vitest";
import { bulkInvoiceSendAuditActions, bulkInvoiceSendDetailsInput, bulkInvoiceSendLogInput, retryFailedInvoiceNotificationInput, sendDeferredInvoiceNotificationsInput } from "./powerhub";

describe("deferred invoice notification input", () => {
  it("uses a bounded batch that remains scoped to one branch", () => {
    expect(sendDeferredInvoiceNotificationsInput.parse({ siteId: 22 })).toMatchObject({ siteId: 22, limit: 200 });
    expect(sendDeferredInvoiceNotificationsInput.parse({ siteId: 22, invoiceIds: [3, 7] })).toMatchObject({ invoiceIds: [3, 7] });
    expect(sendDeferredInvoiceNotificationsInput.safeParse({ siteId: 0 }).success).toBe(false);
    expect(sendDeferredInvoiceNotificationsInput.safeParse({ siteId: 22, limit: 201 }).success).toBe(false);
  });

  it("recognizes both supported invoice bulk-delivery audit actions", () => {
    expect(bulkInvoiceSendAuditActions).toEqual(["send_deferred_invoice_notifications", "send_invoice_sms_batch"]);
  });

  it("accepts a branch-scoped date range and rejects an inverted one", () => {
    expect(bulkInvoiceSendLogInput.parse({ siteId: 22, from: "2026-08-01", to: "2026-08-31" })).toMatchObject({ siteId: 22, from: "2026-08-01", to: "2026-08-31" });
    expect(bulkInvoiceSendLogInput.safeParse({ siteId: 22, from: "2026-08-31", to: "2026-08-01" }).success).toBe(false);
    expect(bulkInvoiceSendDetailsInput.safeParse({ siteId: 22, auditLogId: 8 }).success).toBe(true);
    expect(retryFailedInvoiceNotificationInput.safeParse({ siteId: 22, notificationId: 81 }).success).toBe(true);
    expect(retryFailedInvoiceNotificationInput.safeParse({ siteId: 22, notificationId: 0 }).success).toBe(false);
  });
});
