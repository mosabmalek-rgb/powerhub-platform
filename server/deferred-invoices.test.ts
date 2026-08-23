import { describe, expect, it } from "vitest";
import { bulkInvoiceSendAuditActions, sendDeferredInvoiceNotificationsInput } from "./powerhub";

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
});
