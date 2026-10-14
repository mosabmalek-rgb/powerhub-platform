import { describe, expect, it } from "vitest";
import { decimalAmountToMinorUnits, minorUnitsToAmountString } from "./decimal-money";

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

  it("rejects values outside the two-decimal database currency scale", () => {
    expect(() => decimalAmountToMinorUnits("1.001")).toThrow(/at most two fractional digits/);
    expect(() => decimalAmountToMinorUnits("not-a-number")).toThrow(/at most two fractional digits/);
    expect(() => decimalAmountToMinorUnits("1e3")).toThrow(/at most two fractional digits/);
  });
});
