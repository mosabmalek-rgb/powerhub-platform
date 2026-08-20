import { describe, expect, it } from "vitest";
import { defaultInvoiceMessageTemplates, renderInvoiceMessageTemplate } from "./invoice-message-template";

describe("invoice message templates", () => {
  it("renders the supported invoice variables without leaving placeholders behind", () => {
    const rendered = renderInvoiceMessageTemplate(defaultInvoiceMessageTemplates.whatsapp, {
      subscriber_name: "أحمد",
      invoice_no: "INV-12",
      billing_period: "2026-08",
      total_amount: "33000",
      due_date: "31 آب 2026",
    });
    expect(rendered).toContain("أحمد");
    expect(rendered).toContain("INV-12");
    expect(rendered).not.toContain("{{invoice_no}}");
  });
});
