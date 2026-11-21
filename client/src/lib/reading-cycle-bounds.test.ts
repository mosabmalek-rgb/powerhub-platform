import { describe, expect, it } from "vitest";
import { isUsableReadingCycleBounds } from "./reading-cycle-bounds";

describe("offline reading-cycle bounds", () => {
  const valid = { startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-11-01T00:00:00.000Z" };

  it("accepts a valid saved period even when the last network refresh failed", () => {
    expect(isUsableReadingCycleBounds(valid, false)).toBe(true);
  });

  it("rejects missing, malformed, and reversed bounds", () => {
    expect(isUsableReadingCycleBounds(undefined)).toBe(false);
    expect(isUsableReadingCycleBounds({ startAt: "invalid", endAt: valid.endAt })).toBe(false);
    expect(isUsableReadingCycleBounds({ startAt: valid.endAt, endAt: valid.startAt })).toBe(false);
  });

  it("never uses a cached period after an explicit authorization denial", () => {
    expect(isUsableReadingCycleBounds(valid, true)).toBe(false);
  });
});
