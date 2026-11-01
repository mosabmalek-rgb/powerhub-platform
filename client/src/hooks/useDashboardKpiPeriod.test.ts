import { describe, expect, it } from "vitest";
import {
  dashboardDateKey,
  isValidDashboardDateInput,
  isDashboardKpiPeriodRangeReady,
  parseDashboardKpiPeriod,
} from "./useDashboardKpiPeriod";

describe("dashboard KPI date handling", () => {
  it("accepts valid ISO calendar dates", () => {
    expect(isValidDashboardDateInput("2026-10-20")).toBe(true);
    expect(dashboardDateKey("2026-10-20")).toBe("2026-10-20");
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

describe("dashboard KPI offline period readiness", () => {
  const base = {
    siteId: 7,
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    hasCurrentBounds: true,
    hasPreviousBounds: true,
  };

  it("keeps a valid cached current-cycle range ready even when its live refresh fails", () => {
    expect(isDashboardKpiPeriodRangeReady({ ...base, preset: "current_cycle" })).toBe(true);
  });

  it("requires cached current and previous boundaries for the previous-cycle range", () => {
    expect(isDashboardKpiPeriodRangeReady({ ...base, preset: "previous_cycle", hasPreviousBounds: false })).toBe(false);
    expect(isDashboardKpiPeriodRangeReady({ ...base, preset: "previous_cycle" })).toBe(true);
  });

  it("keeps last-month and custom ranges ready without a cycle-boundary response", () => {
    expect(isDashboardKpiPeriodRangeReady({ ...base, preset: "last_month", hasCurrentBounds: false, hasPreviousBounds: false })).toBe(true);
    expect(isDashboardKpiPeriodRangeReady({ ...base, preset: "custom", hasCurrentBounds: false, hasPreviousBounds: false })).toBe(true);
  });

  it("rejects missing site scope, invalid dates, reversed ranges, and missing current-cycle boundaries", () => {
    expect(isDashboardKpiPeriodRangeReady({ ...base, siteId: null, preset: "custom" })).toBe(false);
    expect(isDashboardKpiPeriodRangeReady({ ...base, preset: "custom", startDate: "2026-02-30" })).toBe(false);
    expect(isDashboardKpiPeriodRangeReady({ ...base, preset: "custom", startDate: "2026-11-01" })).toBe(false);
    expect(isDashboardKpiPeriodRangeReady({ ...base, preset: "current_cycle", hasCurrentBounds: false })).toBe(false);
  });
});
