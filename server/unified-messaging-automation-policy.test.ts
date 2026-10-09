import { describe, expect, it } from "vitest";
import { buildAutomaticOccurrenceKey, isIncrementalAutomaticEvent } from "./unified-messaging-automation-policy";

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
