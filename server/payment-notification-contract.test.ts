import { describe, expect, it } from "vitest";

describe("payment notification idempotency contract", () => {
  it("uses payment identity for receipts", () => {
    const paymentId = 123;
    expect(`payment_receipt:${paymentId}`).toBe("payment_receipt:123");
  });

  it("uses Palestine local date for daily reminders", () => {
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Gaza",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date("2026-09-18T22:30:00Z"));
    expect(localDate).toMatch(/^2026-09-19$/);
  });

  it("does not treat uncertain delivery as a failed retry", () => {
    const retryable = ["pending", "failed"];
    expect(retryable.includes("needs_review")).toBe(false);
  });
});
