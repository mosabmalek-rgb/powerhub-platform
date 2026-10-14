import { describe, expect, it } from "vitest";
import { getSubscriptionRenewalState } from "./subscription-renewal-state";

const base = { status: "active", endsAt: "2026-10-25T00:00:00.000Z" };
const now = new Date("2026-10-15T00:00:00.000Z");

describe("subscription renewal warning schedule", () => {
  it.each([
    [14, "notice"], [7, "warning"], [3, "urgent"], [1, "urgent"], [0, "expired"],
  ] as const)("uses the right reminder level at %i remaining days", (days, urgency) => {
    const endsAt = new Date(now.getTime() + days * 86_400_000);
    const state = getSubscriptionRenewalState({ ...base, endsAt }, now);
    expect(state.urgency).toBe(urgency);
  });

  it("does not show a deadline warning when more than 14 days remain", () => {
    const state = getSubscriptionRenewalState({ ...base, endsAt: new Date(now.getTime() + 20 * 86_400_000) }, now);
    expect(state.urgency).toBe("normal");
    expect(state.notice).toBeNull();
  });

  it("does not claim the subscription is active when the end date is missing", () => {
    const state = getSubscriptionRenewalState({ status: "active", endsAt: null }, now);
    expect(state.urgency).toBe("warning");
    expect(state.notice).toContain("لا يتوفر تاريخ انتهاء موثوق");
  });
});
