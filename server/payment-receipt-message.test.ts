import { describe, expect, it } from "vitest";
import { paymentReceiptTemplateParameters, renderPaymentReceiptMessage, renderPaymentReceiptTemplate } from "./payment-receipt-message";

describe("payment receipt message", () => {
  const receipt = { subscriberName: "أحمد علي", paymentNo: "PAY-001", paymentAmount: 40, invoiceNo: "INV-001", balanceDue: 52 };

  it("renders the payment, invoice, and remaining balance in the recipient message", () => {
    expect(renderPaymentReceiptMessage(receipt)).toContain("تم استلام دفعة بقيمة 40.0");
    expect(renderPaymentReceiptMessage(receipt)).toContain("الرصيد المتبقي: 52.0");
  });

  it("builds the approved WhatsApp template parameters in their documented order", () => {
    expect(paymentReceiptTemplateParameters(receipt)).toEqual(["أحمد علي", "PAY-001", "40.0", "INV-001", "52.0"]);
  });

  it("renders a tenant-specific SMS receipt template with the payment values", () => {
    expect(renderPaymentReceiptTemplate("إيصال {{payment_no}} للمشترك {{subscriber_name}}؛ المتبقي {{balance_due}}.", receipt)).toBe("إيصال PAY-001 للمشترك أحمد علي؛ المتبقي 52.0.");
  });
  
  it("formats receipt amounts to one decimal place", () => {
    const fractionalReceipt = { ...receipt, paymentAmount: 40.45, balanceDue: 52.26 };
    const rendered = renderPaymentReceiptMessage(fractionalReceipt);
    expect(rendered).toContain("بقيمة 40.5");
    expect(rendered).toContain("الرصيد المتبقي: 52.3");
    expect(rendered).not.toContain("40.45");
    expect(rendered).not.toContain("52.26");
    expect(paymentReceiptTemplateParameters(fractionalReceipt)).toEqual(["أحمد علي", "PAY-001", "40.5", "INV-001", "52.3"]);
  });
});
