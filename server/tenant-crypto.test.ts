import { describe, expect, it } from "vitest";

process.env.JWT_SECRET = "powerhub-test-master-key";

import { decryptTenantCredential, encryptTenantCredential, hashWebhookVerifyToken } from "./tenant-crypto";

describe("tenant credential encryption", () => {
  it("encrypts a tenant token without storing its plaintext", () => {
    const secret = "tenant-whatsapp-access-token";
    const encrypted = encryptTenantCredential(secret);
    expect(encrypted.ciphertext).not.toContain(secret);
    expect(decryptTenantCredential(encrypted.ciphertext, encrypted.iv)).toBe(secret);
  });

  it("stores webhook verification only as a stable hash", () => {
    const token = "powerhub-webhook-verify-token";
    expect(hashWebhookVerifyToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashWebhookVerifyToken(token)).toBe(hashWebhookVerifyToken(token));
    expect(hashWebhookVerifyToken(token)).not.toContain(token);
  });
});
