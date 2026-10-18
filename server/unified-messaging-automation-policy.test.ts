import { describe, expect, it } from "vitest";
import { buildAutomaticOccurrenceKey, isIncrementalAutomaticEvent, isInvoiceOverdueEligible } from "./unified-messaging-automation-policy";

describe("automatic messaging occurrence policy", () => {
  it("creates separate scan occurrences each minute for subscriber and payment events", () => {
    const beforeBoundary = new Date("2026-10-09T12:00:59.000Z");
    const sameMinute = new Date("2026-10-09T12:00:01.000Z");
    const afterBoundary = new Date("2026-10-09T12:01:00.000Z");
    const bucket = String(Math.floor(beforeBoundary.getTime() / 60_000));

    expect(buildAutomaticOccurrenceKey("subscriber_created", beforeBoundary))
      .toBe("event:subscriber_created:" + bucket);
    expect(buildAutomaticOccurrenceKey("subscriber_created", beforeBoundary))
      .toBe(buildAutomaticOccurrenceKey("subscriber_created", sameMinute));
    expect(buildAutomaticOccurrenceKey("subscriber_created", afterBoundary))
      .not.toBe(buildAutomaticOccurrenceKey("subscriber_created", beforeBoundary));
    expect(buildAutomaticOccurrenceKey("payment_received", beforeBoundary))
      .toBe("event:payment_received:" + bucket);
  });

  it("keeps recurring reminders and service alerts unique by day", () => {
    expect(buildAutomaticOccurrenceKey("service_alert", new Date("2026-10-09T02:00:00.000Z")))
      .toBe(buildAutomaticOccurrenceKey("service_alert", new Date("2026-10-09T23:00:00.000Z")));
    expect(buildAutomaticOccurrenceKey("invoice_overdue", new Date("2026-10-09T23:00:00.000Z")))
      .toBe("event:invoice_overdue:2026-10-09");
  });

  it("only classifies event scans that must discover records throughout the day as incremental", () => {
    expect(isIncrementalAutomaticEvent("subscriber_created")).toBe(true);
    expect(isIncrementalAutomaticEvent("payment_received")).toBe(true);
    expect(isIncrementalAutomaticEvent("invoice_overdue")).toBe(false);
    expect(isIncrementalAutomaticEvent("service_alert")).toBe(false);
  });
});


describe("overdue invoice reminder hour eligibility", () => {
  const dueDate = "2026-10-10T12:00:00.000Z";

  it("does not qualify before the exact due-plus-hours boundary", () => {
    expect(isInvoiceOverdueEligible({
      dueDate, balanceDue: "50.00", now: new Date("2026-10-11T11:59:59.999Z"), afterDueHours: 24,
    })).toBe(false);
    expect(isInvoiceOverdueEligible({
      dueDate, balanceDue: "50.00", now: new Date("2026-10-11T12:00:00.000Z"), afterDueHours: 24,
    })).toBe(true);
  });

  it("uses elapsed time from the invoice due timestamp regardless of UTC offset notation", () => {
    expect(isInvoiceOverdueEligible({
      dueDate: "2026-10-10T15:00:00+03:00",
      balanceDue: 50,
      now: new Date("2026-10-11T12:00:00.000Z"),
      afterDueHours: 24,
    })).toBe(true);
  });

  it("applies the minimum to the current invoice balance and skips settled or below-threshold invoices", () => {
    const args = { dueDate, now: new Date("2026-10-12T12:00:00.000Z"), afterDueHours: 24, minBalance: 25 };
    expect(isInvoiceOverdueEligible({ ...args, balanceDue: 24.99 })).toBe(false);
    expect(isInvoiceOverdueEligible({ ...args, balanceDue: 25 })).toBe(true);
    expect(isInvoiceOverdueEligible({ ...args, balanceDue: 0 })).toBe(false);
    expect(isInvoiceOverdueEligible({ ...args, balanceDue: null })).toBe(false);
  });

  it("rejects invalid dates and invalid delay configuration", () => {
    expect(isInvoiceOverdueEligible({
      dueDate: "not-a-date", balanceDue: 50, now: new Date("2026-10-12T12:00:00.000Z"), afterDueHours: 24,
    })).toBe(false);
    expect(isInvoiceOverdueEligible({
      dueDate, balanceDue: 50, now: new Date("2026-10-12T12:00:00.000Z"), afterDueHours: -1,
    })).toBe(false);
  });
});
