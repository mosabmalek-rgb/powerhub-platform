import { describe, expect, it } from "vitest";
import { hashMobileToken, mobileApiSchemas } from "./mobile-api";

describe("Mobile API v1 contract", () => {
  it("requires a valid UUID and precision-safe reading value", () => {
    const base = {
      clientOperationId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: 12,
      subscriberId: 456,
      meterId: 789,
      readingValue: "1250.500",
      readingAt: "2026-08-22T14:30:00.000Z",
    };
    expect(mobileApiSchemas.reading.safeParse(base).success).toBe(true);
    expect(mobileApiSchemas.reading.safeParse({ ...base, clientOperationId: "not-a-uuid" }).success).toBe(false);
    expect(mobileApiSchemas.reading.safeParse({ ...base, readingValue: "1250.1234" }).success).toBe(false);
  });

  it("requires email credentials and protects refresh values through a stable hash", () => {
    expect(mobileApiSchemas.login.safeParse({ email: "field@powerhub.test", password: "SecurePass123" }).success).toBe(true);
    expect(mobileApiSchemas.login.safeParse({ email: "not-an-email", password: "short" }).success).toBe(false);
    expect(hashMobileToken("refresh-token-example")).toHaveLength(64);
    expect(hashMobileToken("refresh-token-example")).toBe(hashMobileToken("refresh-token-example"));
    expect(hashMobileToken("refresh-token-example")).not.toBe(hashMobileToken("different-token"));
  });
});
