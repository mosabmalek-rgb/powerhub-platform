import { describe, expect, it } from "vitest";
import { buildMonthlyScheduleAnchor, buildWeeklyScheduleAnchor, MESSAGE_SCHEDULE_TIME_ZONE } from "@/lib/messaging-schedule";
import { formatDateTimeLocalInTimeZone, parseDateTimeLocalInTimeZone } from "@/lib/zoned-date-time";

describe("zoned schedule datetime input", () => {
  it("round-trips an absolute timestamp through Asia/Gaza wall time without shifting it", () => {
    const original = new Date("2026-01-15T09:30:00.000Z");
    const wallTime = formatDateTimeLocalInTimeZone(original, "Asia/Gaza");
    expect(parseDateTimeLocalInTimeZone(wallTime, "Asia/Gaza").toISOString()).toBe(original.toISOString());
  });

  it("parses valid datetime-local values in the configured timezone", () => {
    expect(() => parseDateTimeLocalInTimeZone("2026-10-15T12:30", "Asia/Gaza")).not.toThrow();
  });

  it("rejects invalid wall dates instead of silently normalizing them", () => {
    expect(() => parseDateTimeLocalInTimeZone("2026-02-30T10:00", "Asia/Gaza")).toThrow();
  });
  it("rejects invalid IANA timezones", () => {
    expect(() => parseDateTimeLocalInTimeZone("2026-10-15T12:30", "Invalid/PowerHub")).toThrow();
  });
  it("rejects wall times skipped by daylight-saving transitions", () => {
    expect(() => parseDateTimeLocalInTimeZone("2026-03-08T02:30", "America/New_York")).toThrow(/does not exist/);
  });
});

describe("weekly messaging schedule anchor", () => {
  it("preserves the requested Asia/Gaza weekday and time", () => {
    const anchor = buildWeeklyScheduleAnchor(4, "20:00", new Date("2026-10-09T16:00:00.000Z"));
    expect(formatDateTimeLocalInTimeZone(anchor, MESSAGE_SCHEDULE_TIME_ZONE)).toBe("2026-10-15T20:00");
  });

  it("advances a weekday occurrence when today's selected time has already passed", () => {
    const now = parseDateTimeLocalInTimeZone("2026-10-15T21:00", MESSAGE_SCHEDULE_TIME_ZONE);
    const anchor = buildWeeklyScheduleAnchor(4, "20:00", now);
    expect(formatDateTimeLocalInTimeZone(anchor, MESSAGE_SCHEDULE_TIME_ZONE)).toBe("2026-10-22T20:00");
  });
});
describe("monthly messaging schedule anchor", () => {
  it("preserves day 31 when the current month has fewer than 31 days", () => {
    const anchor = buildMonthlyScheduleAnchor(31, "20:00", new Date("2026-02-05T09:00:00.000Z"));
    expect(formatDateTimeLocalInTimeZone(anchor, MESSAGE_SCHEDULE_TIME_ZONE)).toBe("2026-03-31T20:00");
  });

  it("preserves day 30 when the current month has only 28 days", () => {
    const anchor = buildMonthlyScheduleAnchor(30, "08:15", new Date("2026-02-05T09:00:00.000Z"));
    expect(formatDateTimeLocalInTimeZone(anchor, MESSAGE_SCHEDULE_TIME_ZONE)).toBe("2026-03-30T08:15");
  });

  it("keeps valid day 29 in a month that already contains it", () => {
    const anchor = buildMonthlyScheduleAnchor(29, "07:05", new Date("2028-02-05T08:00:00.000Z"));
    expect(formatDateTimeLocalInTimeZone(anchor, MESSAGE_SCHEDULE_TIME_ZONE)).toBe("2028-02-29T07:05");
  });

  it("advances to the next month when this month's scheduled time has passed", () => {
    const now = parseDateTimeLocalInTimeZone("2026-10-09T21:00", MESSAGE_SCHEDULE_TIME_ZONE);
    const anchor = buildMonthlyScheduleAnchor(9, "20:00", now);
    expect(formatDateTimeLocalInTimeZone(anchor, MESSAGE_SCHEDULE_TIME_ZONE)).toBe("2026-11-09T20:00");
  });

  it("skips a short month when the selected day does not exist in the following month", () => {
    const now = parseDateTimeLocalInTimeZone("2026-03-31T21:00", MESSAGE_SCHEDULE_TIME_ZONE);
    const anchor = buildMonthlyScheduleAnchor(31, "20:00", now);
    expect(formatDateTimeLocalInTimeZone(anchor, MESSAGE_SCHEDULE_TIME_ZONE)).toBe("2026-05-31T20:00");
  });
});
