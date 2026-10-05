import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderInvoiceMessageTemplate } from "./invoice-message-template";

const sendType = z.enum(["manual","automatic","scheduled"]);
const scheduleType = z.enum(["none","one_time","weekly","every_10_days","every_15_days","monthly","custom"]);

describe("unified messaging contract", () => {
  it("supports the three delivery modes", () => {
    expect(sendType.options).toEqual(["manual","automatic","scheduled"]);
  });
  it("supports one-time and recurring schedules", () => {
    expect(scheduleType.options).toEqual(["none","one_time","weekly","every_10_days","every_15_days","monthly","custom"]);
  });
  it("does not accept an unsupported delivery mode", () => {
    expect(() => sendType.parse("instant")).toThrow();
  });
  it("renders stable invoice tokens to their final values", () => {
    const message = renderInvoiceMessageTemplate("مرحباً {{subscriber_name}}، فاتورتك {{invoice_no}} بقيمة {{total_amount}}. {{invoice_link}}", {
      subscriber_name: "أحمد", invoice_no: "INV-1", billing_period: "سبتمبر", total_amount: "100", due_date: "10 أكتوبر",
      invoice_link: "https://powerhub.example/i/token", portal_link: "https://powerhub.example/portal?g=1", subscriber_no: "SUB-1",
    });
    expect(message).toContain("أحمد");
    expect(message).toContain("INV-1");
    expect(message).toContain("https://powerhub.example/i/token");
    expect(message).not.toContain("{{subscriber_name}}");
  });
});
