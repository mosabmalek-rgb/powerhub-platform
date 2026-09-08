import { describe, expect, it } from "vitest";
import { isTenantSubscriptionActive } from "./subscription-access";

const now = new Date("2026-09-08T12:00:00.000Z");

describe("tenant subscription access policy", () => {
  it("allows an active subscription before endsAt", () => {
    expect(isTenantSubscriptionActive({ status: "active", endsAt: new Date("2026-09-09T12:00:00.000Z") }, now)).toBe(true);
  });

  it("denies an active subscription at or after endsAt", () => {
    expect(isTenantSubscriptionActive({ status: "active", endsAt: now }, now)).toBe(false);
    expect(isTenantSubscriptionActive({ status: "active", endsAt: new Date("2026-09-07T12:00:00.000Z") }, now)).toBe(false);
  });

  it("allows an unexpired trial", () => {
    expect(isTenantSubscriptionActive({ status: "trial", endsAt: new Date("2026-09-08T12:00:01.000Z") }, now)).toBe(true);
  });

  it("denies overdue, suspended, and cancelled subscriptions", () => {
    expect(isTenantSubscriptionActive({ status: "overdue", endsAt: new Date("2026-09-20T12:00:00.000Z") }, now)).toBe(false);
    expect(isTenantSubscriptionActive({ status: "suspended", endsAt: new Date("2026-09-20T12:00:00.000Z") }, now)).toBe(false);
    expect(isTenantSubscriptionActive({ status: "cancelled", endsAt: new Date("2026-09-20T12:00:00.000Z") }, now)).toBe(false);
  });

  it("denies a missing subscription", () => {
    expect(isTenantSubscriptionActive(null, now)).toBe(false);
  });

  it("treats an active subscription without endsAt as non-expiring", () => {
    expect(isTenantSubscriptionActive({ status: "active", endsAt: null }, now)).toBe(true);
  });
});
