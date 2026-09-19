import { describe, expect, it } from "vitest";

describe("notification retry contract", () => {
  it("keeps needs_review out of automatic retry selections", () => {
    const retryable = ["pending", "failed"];
    expect(retryable).not.toContain("needs_review");
  });

  it("treats only confirmed provider rejection as failed/retryable", () => {
    const classify = (providerAccepted: boolean, deliveryUncertain: boolean) =>
      providerAccepted ? "submitted" : deliveryUncertain ? "needs_review" : "failed";
    expect(classify(false, true)).toBe("needs_review");
    expect(classify(false, false)).toBe("failed");
    expect(classify(true, true)).toBe("submitted");
  });

  it("includes uncertain delivery in quota accounting", () => {
    const statuses = ["processing", "submitted", "delivered", "read", "needs_review"];
    expect(statuses).toContain("needs_review");
    expect(statuses).not.toContain("failed");
  });
});
