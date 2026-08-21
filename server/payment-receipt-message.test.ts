import { describe, expect, it } from "vitest";
import { paymentReceiptTemplateParameters, renderPaymentReceiptMessage, renderPaymentReceiptTemplate } from "./payment-receipt-message";

describe("payment receipt message", () => {
  const receipt = { subscriberName: "أحمد علي", paymentNo: "PAY-001", paymentAmount: 40, invoiceNo: "INV-001", balanceDue: 52 };

  it("renders the payment, invoice, and remaining balance in the recipient message", () => {
    expect(renderPaymentReceiptMessage(receipt)).toContain("تم استلام دفعة بقيمة 40");
    expect(renderPaymentReceiptMessage(receipt)).toContain("الرصيد المتبقي: 52");
  });

  it("builds the approved WhatsApp template parameters in their documented order", () => {
    expect(paymentReceiptTemplateParameters(receipt)).toEqual(["أحمد علي", "PAY-001", "40", "INV-001", "52"]);
  });

  it("renders a tenant-specific SMS receipt template with the payment values", () => {
    expect(renderPaymentReceiptTemplate("إيصال {{payment_no}} للمشترك {{subscriber_name}}؛ المتبقي {{balance_due}}.", receipt)).toBe("إيصال PAY-001 للمشترك أحمد علي؛ المتبقي 52.");
  });
});
