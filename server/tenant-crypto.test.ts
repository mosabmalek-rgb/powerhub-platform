import { describe, expect, it } from "vitest";

process.env.JWT_SECRET = "powerhub-test-master-key";

import { decryptTenantCredential, encryptTenantCredential } from "./tenant-crypto";

describe("tenant credential encryption", () => {
  it("encrypts a tenant token without storing its plaintext", () => {
    const secret = "tenant-whatsapp-access-token";
    const encrypted = encryptTenantCredential(secret);
    expect(encrypted.ciphertext).not.toContain(secret);
    expect(decryptTenantCredential(encrypted.ciphertext, encrypted.iv)).toBe(secret);
  });
});
