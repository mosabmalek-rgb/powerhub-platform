import { describe, expect, it } from "vitest";
import {
  dashboardDateKey,
  isValidDashboardDateInput,
  parseDashboardKpiPeriod,
} from "./useDashboardKpiPeriod";

describe("dashboard KPI date handling", () => {
  it("accepts valid ISO calendar dates", () => {
    expect(isValidDashboardDateInput("2026-10-20")).toBe(true);
    expect(dashboardDateKey("2026-10-20")).toBe("2026-10-20");
  });

  it("uses the Gaza calendar date when UTC is still on the previous day", () => {
    const instant = new Date("2026-10-30T23:30:00.000Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-10-30");
    expect(dashboardDateKey(instant)).toBe("2026-10-31");
  });

  it("rejects malformed and impossible calendar dates", () => {
    for (const value of ["2026/10/20", "20-10-2026", "2026-02-30", "not-a-date"]) {
      expect(isValidDashboardDateInput(value)).toBe(false);
    }
  });

  it("keeps valid date filters when parsing dashboard navigation URLs", () => {
    expect(
      parseDashboardKpiPeriod("?debtorPeriod=custom&startDate=2026-10-01&endDate=2026-10-20"),
    ).toMatchObject({
      preset: "custom",
      startDate: "2026-10-01",
      endDate: "2026-10-20",
    });
  });

  it("ignores invalid date filters from navigation URLs", () => {
    expect(
      parseDashboardKpiPeriod("?debtorPeriod=custom&startDate=2026-02-30&endDate=2026-10-20"),
    ).toMatchObject({ preset: "custom", endDate: "2026-10-20" });
    expect(parseDashboardKpiPeriod("?debtorPeriod=custom&startDate=2026-02-30")).not.toHaveProperty(
      "startDate",
    );
  });
});
