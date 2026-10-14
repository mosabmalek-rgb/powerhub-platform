import { describe, expect, it } from "vitest";
import { defaultInvoiceMessageTemplates, defaultPaymentReminderSmsTemplate, renderInvoiceMessageTemplate } from "./invoice-message-template";

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
    const readings = renderInvoiceMessageTemplate("السابقة {{previous_reading}}، الحالية {{current_reading}}، الاستهلاك {{consumption_kwh}}", {
      previous_reading: "12450",
      current_reading: "12785",
      consumption_kwh: "335",
    });
    expect(readings).toBe("السابقة 12450، الحالية 12785، الاستهلاك 335");
    expect(readings).not.toContain("{{previous_reading}}");
    expect(readings).not.toContain("{{current_reading}}");
    expect(readings).not.toContain("{{consumption_kwh}}");
    const balance = renderInvoiceMessageTemplate("المستحقات الإجمالية {{total_balance}} شيكل", { total_balance: "42,500" });
    expect(balance).toBe("المستحقات الإجمالية 42,500.0 شيكل");
    expect(balance).not.toContain("{{total_balance}}");
  });


  it("formats invoice totals and outstanding balances to one decimal in templates", () => {
    const rendered = renderInvoiceMessageTemplate("الإجمالي {{total_amount}}، المستحق {{balance_due}}، الرصيد {{total_balance}}", { total_amount: "390.00", balance_due: "150.25", total_balance: "1,000.99" });
    expect(rendered).toBe("الإجمالي 390.0، المستحق 150.3، الرصيد 1,001.0");
  });

  it("renders the dedicated payment reminder template with balance and deferred invoice-link placeholder", () => {
    const rendered = renderInvoiceMessageTemplate(defaultPaymentReminderSmsTemplate, {
      subscriber_name: "أحمد",
      invoice_no: "INV-77",
      balance_due: "125.50",
      due_date: "2026-10-15",
      invoice_link: "{{invoice_link}}",
    });
    expect(rendered).toContain("INV-77");
    expect(rendered).toContain("125.5");
    expect(rendered).toContain("{{invoice_link}}");
  });
});
