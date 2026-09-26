import { describe, expect, it } from "vitest";
import { getEffectiveAdminSubscriptionStatus, getNextRenewalEndDate, isEffectivelyActiveAdminSubscription } from "./admin-subscription-lifecycle";

describe("admin subscription lifecycle", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");

  it("derives expired from trial/active plus an elapsed endsAt", () => {
    expect(getEffectiveAdminSubscriptionStatus("trial", "2026-09-12T18:43:46.689Z", null, now)).toBe("expired");
    expect(getEffectiveAdminSubscriptionStatus("active", "2026-10-01T00:00:00.000Z", null, now)).toBe("active");
  });

  it("keeps explicit terminal states authoritative", () => {
    expect(getEffectiveAdminSubscriptionStatus("cancelled", "2026-10-01T00:00:00.000Z", null, now)).toBe("cancelled");
    expect(getEffectiveAdminSubscriptionStatus("active", "2026-09-01T00:00:00.000Z", "2026-09-20T00:00:00.000Z", now)).toBe("archived");
  });

  it("counts only effectively active or trial subscriptions", () => {
    expect(isEffectivelyActiveAdminSubscription("trial", "2026-09-12T00:00:00.000Z", null, now)).toBe(false);
    expect(isEffectivelyActiveAdminSubscription("active", "2026-10-12T00:00:00.000Z", null, now)).toBe(true);
  });

  it("starts renewal from now when the previous expiry is already in the past", () => {
    const next = getNextRenewalEndDate("2026-08-12T00:00:00.000Z", "monthly", now);
    expect(next.getTime()).toBe(new Date("2026-10-26T12:00:00.000Z").getTime());
  });

  it("extends from the current end when still active", () => {
    const next = getNextRenewalEndDate("2026-10-12T00:00:00.000Z", "monthly", now);
    expect(next.getTime()).toBe(new Date("2026-11-12T00:00:00.000Z").getTime());
  });
});
