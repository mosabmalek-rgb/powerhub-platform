import { describe, expect, it } from "vitest";
import { reportDateRange } from "./powerhub";

describe("reportDateRange", () => {
  it("keeps the selected start date and makes the selected end date inclusive", () => {
    const range = reportDateRange("2026-07-01", "2026-07-31");

    expect(range.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});
