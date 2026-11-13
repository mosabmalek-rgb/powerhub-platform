import {describe,it,expect} from "vitest";
import {isEarlierGLPeriod,previousGLPeriodOptions} from "./financial-gl-comparison-periods";

describe("Phase C comparative period input normalization",()=>{
 it("selects the immediately previous month and includes Oct in November selection",()=>{
  expect(previousGLPeriodOptions("2026-11").slice(0,3)).toEqual([
   "2026-10","2026-09","2026-08",
  ]);
  expect(isEarlierGLPeriod("2026-10","2026-11")).toBe(true);
 });
 it("handles year transitions and leap-year February without browser-local timezone",()=>{
  expect(previousGLPeriodOptions("2026-01",3)).toEqual(["2025-12","2025-11","2025-10"]);
  expect(previousGLPeriodOptions("2024-03",3)).toEqual(["2024-02","2024-01","2023-12"]);
 });
 it("rejects invalid or current/future months and malformed manual values",()=>{
  for(const period of ["","2026-1","2026-00","2026-13","abc","2026-11-01","0000-12"])
   expect(isEarlierGLPeriod(period,"2026-11")).toBe(false);
  expect(isEarlierGLPeriod("2026-11","2026-11")).toBe(false);
  expect(isEarlierGLPeriod("2026-12","2026-11")).toBe(false);
  expect(isEarlierGLPeriod("2020-01","2026-11")).toBe(true);
  expect(previousGLPeriodOptions("not-a-period")).toEqual([]);
  expect(previousGLPeriodOptions("2026-11",121)).toEqual([]);
 });
 it("preserves a distinct older period without being limited to the quick-choice window",()=>{
  expect(previousGLPeriodOptions("2026-11",36)).toHaveLength(36);
  expect(isEarlierGLPeriod("2016-04","2026-11")).toBe(true);
 });
});
