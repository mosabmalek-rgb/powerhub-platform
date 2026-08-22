import { describe, expect, it } from "vitest";
import { buildPayrollDetailRow } from "./payroll-report";

describe("payroll detailed export rows", () => {
  it("maps employee and payroll line items into an archival row", () => {
    expect(buildPayrollDetailRow("2026-08", { employee: { fullName: "سيف مصعب", jobTitle: "محاسب" }, item: { baseAmount: "3200", extraAmount: "450", advanceDeduction: "300", otherDeduction: "50", netAmount: "3300" } })).toEqual({ period: "2026-08", employee: "سيف مصعب", jobTitle: "محاسب", base: 3200, extra: 450, advance: 300, other: 50, net: 3300 });
  });
});
