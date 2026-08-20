import { describe, expect, it, vi } from "vitest";
import { probeMessagingConnection } from "./messaging-connection";

describe("messaging connection probes", () => {
  it("verifies a Meta WhatsApp credential without persisting it", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "123" }), { status: 200 }));
    const result = await probeMessagingConnection({ channel: "whatsapp", provider: "meta_whatsapp_cloud", credential: "test-token", phoneNumberId: "123" }, fetcher);
    expect(result).toMatchObject({ ok: true, mode: "live" });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("graph.facebook.com"), expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }));
  });

  it("requires a supported SMS provider before it claims a live connection test", async () => {
    const result = await probeMessagingConnection({ channel: "sms", provider: "generic_sms", credential: "test-token" });
    expect(result).toMatchObject({ ok: false, mode: "configuration" });
  });
});
