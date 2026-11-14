import { describe,expect,it } from "vitest";
import { financialTrendMonths } from "./financial-trend-months";

describe("financial trend calendar boundaries",()=>{
  it("produces six adjacent calendar months in chronological order",()=>{
    const periods=financialTrendMonths("2026-11-09");
    expect(periods).toHaveLength(6);
    expect(periods[0]).toEqual({month:"2026-06",startDate:"2026-06-01",endDate:"2026-06-30"});
    expect(periods[5]).toEqual({month:"2026-11",startDate:"2026-11-01",endDate:"2026-11-09"});
  });
  it("handles year boundary and leap-year February without overlap",()=>{
    const periods=financialTrendMonths("2024-02-29",3);
    expect(periods.map(p=>p.month)).toEqual(["2023-12","2024-01","2024-02"]);
    expect(periods[2].endDate).toBe("2024-02-29");
    expect(financialTrendMonths("2025-02-05",1)[0].endDate).toBe("2025-02-05");
  });
  it("rejects invalid dates and unbounded requests",()=>{
    expect(()=>financialTrendMonths("2026-02-30")).toThrow();
    expect(()=>financialTrendMonths("2026-11-09",13)).toThrow();
    expect(()=>financialTrendMonths("2026-11-09",0)).toThrow();
  });
});
