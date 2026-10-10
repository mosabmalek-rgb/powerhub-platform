import { describe, expect, it } from "vitest";
import { hasFieldAppAccess, hashMobileToken, mobileApiSchemas } from "./mobile-api";

describe("Mobile API v1 contract", () => {
  it("requires a valid UUID and precision-safe subscriber reading without a meter identifier", () => {
    const base = {
      clientOperationId: "550e8400-e29b-41d4-a716-446655440000",
      branchId: 12,
      subscriberId: 456,
      readingValue: "1250.50",
      readingAt: "2026-08-22T14:30:00.000Z",
    };
    expect(mobileApiSchemas.reading.safeParse(base).success).toBe(true);
    expect(mobileApiSchemas.reading.safeParse({ ...base, clientOperationId: "not-a-uuid" }).success).toBe(false);
    expect(mobileApiSchemas.reading.safeParse({ ...base, readingValue: "1250.123" }).success).toBe(false);
    expect(mobileApiSchemas.reading.safeParse({ ...base, readingValue: "12" }).success).toBe(true);
    expect(mobileApiSchemas.reading.safeParse({ ...base, readingValue: "12.5" }).success).toBe(true);
    expect(mobileApiSchemas.reading.safeParse({ ...base, readingValue: "12.52" }).success).toBe(true);
    expect(mobileApiSchemas.reading.safeParse({ ...base, meterId: 789 }).success).toBe(false);
    expect(mobileApiSchemas.reading.safeParse({ ...base, subscriberId: 0 }).success).toBe(false);
  });

  it("requires email credentials and protects refresh values through a stable hash", () => {
    expect(mobileApiSchemas.login.safeParse({ email: "field@powerhub.test", password: "SecurePass123" }).success).toBe(true);
    expect(mobileApiSchemas.login.safeParse({ email: "not-an-email", password: "short" }).success).toBe(false);
    expect(mobileApiSchemas.changePassword.safeParse({ newPassword: "NewSecurePass123" }).success).toBe(true);
    expect(mobileApiSchemas.changePassword.safeParse({ newPassword: "short" }).success).toBe(false);
    expect(hashMobileToken("refresh-token-example")).toHaveLength(64);
    expect(hashMobileToken("refresh-token-example")).toBe(hashMobileToken("refresh-token-example"));
    expect(hashMobileToken("refresh-token-example")).not.toBe(hashMobileToken("different-token"));
  });

  it("allows only the technician role into the field app", () => {
    expect(hasFieldAppAccess("technician", ["recordReadings"])).toBe(false);
    expect(hasFieldAppAccess("technician", ["accessFieldApp"])).toBe(false);
    expect(hasFieldAppAccess("technician", ["recordReadings", "accessFieldApp"])).toBe(true);
    expect(hasFieldAppAccess("owner", ["recordReadings", "accessFieldApp"])).toBe(false);
    expect(hasFieldAppAccess("manager", ["recordReadings", "accessFieldApp"])).toBe(false);
    expect(hasFieldAppAccess("collector", ["recordReadings", "accessFieldApp"])).toBe(false);
  });

  it("accepts bounded sync telemetry and rejects invalid event identity, branch, and counts", () => {
    const event = {
      eventKey: "7f2d7c9e-3921-4cc5-9dc2-53a79f998b8e",
      branchId: 12,
      eventType: "sync_cycle",
      status: "partial",
      syncedCount: 8,
      retryableCount: 1,
      needsReviewCount: 0,
      occurredAt: "2026-08-23T10:15:00.000Z",
    };
    expect(mobileApiSchemas.syncEvent.safeParse(event).success).toBe(true);
    expect(mobileApiSchemas.syncEvent.safeParse({ ...event, eventKey: "not-a-uuid" }).success).toBe(false);
    expect(mobileApiSchemas.syncEvent.safeParse({ ...event, branchId: 0 }).success).toBe(false);
    expect(mobileApiSchemas.syncEvent.safeParse({ ...event, retryableCount: -1 }).success).toBe(false);
    expect(mobileApiSchemas.syncEvent.safeParse({ ...event, syncedCount: 10_001 }).success).toBe(false);
  });
});
