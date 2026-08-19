import { describe, expect, it } from "vitest";
import { resolveInvoiceNotificationChannels } from "./notification-channels";

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
});
