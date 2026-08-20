import { describe, expect, it } from "vitest";
import { invoiceDeliveryPolicyFromSetting, resolveInvoiceNotificationChannels } from "./notification-channels";

describe("invoice notification channels", () => {
  it("queues one message for each active WhatsApp and SMS channel", () => {
    expect(resolveInvoiceNotificationChannels([
      { channel: "whatsapp", isActive: true },
      { channel: "sms", isActive: true },
    ])).toEqual(["whatsapp", "sms"]);
  });

  it("does not queue an inactive channel", () => {
    expect(resolveInvoiceNotificationChannels([
      { channel: "whatsapp", isActive: true },
      { channel: "sms", isActive: false },
    ])).toEqual(["whatsapp"]);
  });

  it("preserves the local WhatsApp queue fallback before configuration", () => {
    expect(resolveInvoiceNotificationChannels([])).toEqual(["whatsapp"]);
  });

  it("honours the platform administrator switches for both invoice channels", () => {
    const smsOnly = invoiceDeliveryPolicyFromSetting({ isEnabled: true, value: { whatsappEnabled: false, smsEnabled: true } });
    expect(resolveInvoiceNotificationChannels([{ channel: "whatsapp", isActive: true }, { channel: "sms", isActive: true }], smsOnly)).toEqual(["sms"]);
    expect(resolveInvoiceNotificationChannels([], invoiceDeliveryPolicyFromSetting({ isEnabled: false }))).toEqual([]);
  });
});
