import { describe, expect, it } from "vitest";
import { decimalAmountToMinorUnits, formatMessageAmount, formatPolicyAwareMessageAmount, minorUnitsToAmountString } from "./decimal-money";

describe("exact decimal amount conversion", () => {
  it("sums decimal currency amounts without floating-point drift", () => {
    const total =
      decimalAmountToMinorUnits("0.10") +
      decimalAmountToMinorUnits("0.20") +
      decimalAmountToMinorUnits("0.05");

    expect(minorUnitsToAmountString(total)).toBe("0.35");
  });

  it("preserves large balances and fractional cents exactly", () => {
    const total =
      decimalAmountToMinorUnits("100000000000.05") +
      decimalAmountToMinorUnits("0.20") +
      decimalAmountToMinorUnits("12.5");

    expect(minorUnitsToAmountString(total)).toBe("100000000012.75");
  });

  it("normalizes trailing zeroes without losing value", () => {
    expect(minorUnitsToAmountString(decimalAmountToMinorUnits("42.50"))).toBe("42.5");
    expect(minorUnitsToAmountString(decimalAmountToMinorUnits("42.00"))).toBe("42");
    expect(minorUnitsToAmountString(decimalAmountToMinorUnits("0"))).toBe("0");
  });

  it("treats nullish database values as zero and supports negative values", () => {
    expect(decimalAmountToMinorUnits(null)).toBe(0n);
    expect(decimalAmountToMinorUnits(undefined)).toBe(0n);
    expect(minorUnitsToAmountString(decimalAmountToMinorUnits("-0.05"))).toBe("-0.05");
  });

  it("formats message amounts to one decimal with decimal-safe rounding and grouping", () => {
    expect(formatMessageAmount("125.50")).toBe("125.5");
    expect(formatMessageAmount("125.54")).toBe("125.5");
    expect(formatMessageAmount("125.55")).toBe("125.6");
    expect(formatMessageAmount("999.99")).toBe("1,000.0");
    expect(formatMessageAmount("42,500.00")).toBe("42,500.0");
    expect(formatMessageAmount("-0.06")).toBe("-0.1");
    expect(formatMessageAmount(null)).toBe("");
  });


  it("hides fractions without rounding up when a settlement policy is enabled", () => {
    expect(formatPolicyAwareMessageAmount("40.45", true)).toBe("40");
    expect(formatPolicyAwareMessageAmount("120.80", true)).toBe("120");
    expect(formatPolicyAwareMessageAmount("40.50", true)).toBe("40");
    expect(formatPolicyAwareMessageAmount("999.99", true)).toBe("999");
    expect(formatPolicyAwareMessageAmount("-40.50", true)).toBe("-40");
  });

  it("shows at most one decimal when settlement policies are disabled", () => {
    expect(formatPolicyAwareMessageAmount("40.45", false)).toBe("40.5");
    expect(formatPolicyAwareMessageAmount("52.26", false)).toBe("52.3");
    expect(formatPolicyAwareMessageAmount("40.00", false)).toBe("40.0");
  });

  it("rejects values outside the two-decimal database currency scale", () => {
    expect(() => decimalAmountToMinorUnits("1.001")).toThrow(/at most two fractional digits/);
    expect(() => decimalAmountToMinorUnits("not-a-number")).toThrow(/at most two fractional digits/);
    expect(() => decimalAmountToMinorUnits("1e3")).toThrow(/at most two fractional digits/);
  });
});
