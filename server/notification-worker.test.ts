import { describe, expect, it } from "vitest";
import { parseWhatsAppCredential } from "./notification-worker";

describe("WhatsApp notification credential parser", () => {
  it("supports the structured encrypted credential payload", () => {
    const credential = JSON.stringify({ accessToken: "meta-access-token", appSecret: "meta-app-secret" });
    expect(parseWhatsAppCredential(credential, "unused")).toEqual({ accessToken: "meta-access-token", appSecret: "meta-app-secret" });
  });

  it("supports a legacy raw access token", () => {
    expect(parseWhatsAppCredential("legacy-token", "unused")).toEqual({ accessToken: "legacy-token" });
  });
});
