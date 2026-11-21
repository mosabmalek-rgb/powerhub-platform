import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sumKnownFinancialAmounts } from "./financial-known-amounts";

describe("D42 financial UI totals never invent a missing GL amount", () => {
  it("sums valid decimal inputs in minor units and preserves signed corrections", () => {
    expect(sumKnownFinancialAmounts("3.20", "0.15")).toBe(3.35);
    expect(sumKnownFinancialAmounts(0, "0")).toBe(0);
    expect(sumKnownFinancialAmounts("-1.01", 2.22)).toBe(1.21);
    expect(sumKnownFinancialAmounts("0.10", "0.20")).toBe(0.3);
  });

  it.each([
    [null, 2], [undefined, "2"], ["", 1], [" ", 1],
    ["not-a-number", 2], [NaN, 1], [Infinity, 1], [false, 1],
    ["1,234", 2], [{ value: 1 }, 2], ["0.001", 2],
    [Number.MAX_SAFE_INTEGER, 2],
  ])("withholds the total on incomplete or invalid constituent values (%s, %s)", (a, b) => {
    expect(sumKnownFinancialAmounts(a, b)).toBeNull();
  });

  it("does not allow a zero-argument or one-valid-one-missing total", () => {
    expect(sumKnownFinancialAmounts()).toBeNull();
    expect(sumKnownFinancialAmounts(5, undefined)).toBeNull();
  });

  it("wires the financial audit UI to the complete-input rule instead of Number(x)||0", () => {
    const ui = readFileSync("client/src/components/finance/FinancialGLAuditPanel.tsx", "utf8");
    expect(ui).toContain("sumKnownFinancialAmounts(b1Income.depreciation, b1Income.provisions)");
    expect(ui).not.toContain("(Number(b1Income.depreciation)||0)+(Number(b1Income.provisions)||0)");
    expect(ui).toContain('return "غير متاح"');
  });
});
