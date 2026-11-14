import { describe, expect, it } from "vitest";
import { activeTenantMembershipOrFilter, isTenantMembershipUnexpired } from "./tenant-membership-expiry";

describe("tenant membership expiry boundary", () => {
  const now = new Date("2026-11-02T12:00:00.000Z");

  it("treats explicit null expiry as indefinite but rejects missing membership", () => {
    expect(isTenantMembershipUnexpired({ expires_at: null }, now)).toBe(true);
    expect(isTenantMembershipUnexpired(undefined, now)).toBe(false);
  });

  it("accepts a future expiry and rejects the exact boundary and the past", () => {
    expect(isTenantMembershipUnexpired({ expires_at: "2026-11-02T12:00:00.001Z" }, now)).toBe(true);
    expect(isTenantMembershipUnexpired({ expires_at: "2026-11-02T12:00:00.000Z" }, now)).toBe(false);
    expect(isTenantMembershipUnexpired({ expires_at: "2026-11-02T11:59:59.999Z" }, now)).toBe(false);
  });

  it("fails closed for invalid timestamps", () => {
    expect(isTenantMembershipUnexpired({ expires_at: "invalid" }, now)).toBe(false);
  });

  it("uses an ISO timestamp in the PostgREST predicate", () => {
    expect(activeTenantMembershipOrFilter(now)).toBe(
      "expires_at.is.null,expires_at.gt.2026-11-02T12:00:00.000Z",
    );
  });
});
