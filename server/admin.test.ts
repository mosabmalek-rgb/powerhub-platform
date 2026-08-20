import { describe, expect, it } from "vitest";
import { addSubscriptionPeriod, adminRouter, tenantStatusForSubscription } from "./admin";

const baseUser = {
  id: 1,
  openId: "test-user",
  name: "Test User",
  email: null,
  loginMethod: "manus",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
} as const;

describe("platform administration guards and subscription dates", () => {
  it("blocks a tenant user before any platform-wide query runs", async () => {
    const caller = adminRouter.createCaller({ user: { ...baseUser, role: "user" }, req: {} as never, res: {} as never });
    await expect(caller.overview()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("extends monthly and yearly subscriptions from the supplied date", () => {
    expect(addSubscriptionPeriod(new Date("2026-01-15T00:00:00Z"), "monthly", 2).toISOString()).toContain("2026-03-15");
    expect(addSubscriptionPeriod(new Date("2026-01-15T00:00:00Z"), "yearly", 1).toISOString()).toContain("2027-01-15");
  });

  it("maps suspended and cancelled subscriptions to a suspended tenant", () => {
    expect(tenantStatusForSubscription("suspended")).toBe("suspended");
    expect(tenantStatusForSubscription("cancelled")).toBe("suspended");
    expect(tenantStatusForSubscription("active")).toBe("active");
  });
});
