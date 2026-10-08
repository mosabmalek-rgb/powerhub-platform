import { describe, expect, it } from "vitest";
import { buildMonthlyScheduleAnchor } from "./MessagingSettingsPage";

describe("monthly messaging schedule anchor", () => {
  it("preserves day 31 when the current month has fewer than 31 days", () => {
    const anchor = buildMonthlyScheduleAnchor(31, "20:00", new Date(2026, 1, 5, 12, 0, 0, 0));
    const date = new Date(anchor);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(31);
    expect(date.getHours()).toBe(20);
    expect(date.getMinutes()).toBe(0);
  });

  it("preserves day 30 when the current month has only 28 days", () => {
    const anchor = buildMonthlyScheduleAnchor(30, "08:15", new Date(2026, 1, 5, 12, 0, 0, 0));
    const date = new Date(anchor);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(30);
    expect(date.getHours()).toBe(8);
    expect(date.getMinutes()).toBe(15);
  });

  it("keeps valid day 29 in a month that already contains it", () => {
    const anchor = buildMonthlyScheduleAnchor(29, "07:05", new Date(2028, 1, 5, 12, 0, 0, 0));
    const date = new Date(anchor);
    expect(date.getFullYear()).toBe(2028);
    expect(date.getMonth()).toBe(1);
    expect(date.getDate()).toBe(29);
  });
});
