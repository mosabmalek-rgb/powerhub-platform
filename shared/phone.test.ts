import { describe, expect, it } from "vitest";
import { normalizeInternationalPhone, phoneSearchVariants } from "./phone";

describe("international phone normalization", () => {
  it("keeps an E.164 number and removes readable separators", () => {
    expect(normalizeInternationalPhone("+970 599-000-000")).toBe("+970599000000");
  });

  it("converts the 00 prefix to an international plus prefix", () => {
    expect(normalizeInternationalPhone("00970599000000")).toBe("+970599000000");
  });

  it("converts Palestinian local 059 and 056 numbers to canonical E.164", () => {
    expect(normalizeInternationalPhone("0599000000")).toBe("+970599000000");
    expect(normalizeInternationalPhone("0569000000")).toBe("+970569000000");
  });

  it("restores a leading zero dropped by spreadsheets for Palestinian mobile numbers", () => {
    expect(normalizeInternationalPhone("599000000")).toBe("+970599000000");
    expect(normalizeInternationalPhone("569000000")).toBe("+970569000000");
    expect(normalizeInternationalPhone("0599000000")).toBe("+970599000000");
    expect(normalizeInternationalPhone("0569000000")).toBe("+970569000000");
  });

  it("accepts 970, 972, and 00-prefixed country codes", () => {
    expect(normalizeInternationalPhone("970599000000")).toBe("+970599000000");
    expect(normalizeInternationalPhone("+972599000000")).toBe("+970599000000");
    expect(normalizeInternationalPhone("00972569000000")).toBe("+970569000000");
  });
});

describe("Palestinian phone search variants", () => {
  const equivalent = [
    "+970598082061",
    "00970598082061",
    "0598082061",
    "+972598082061",
    "00972598082061",
    "970598082061",
    "972598082061",
    "598082061",
  ];
  it.each(equivalent)("treats %s as the same 059 number", (value) => {
    const variants = new Set(phoneSearchVariants(value));
    for (const expected of ["+970598082061","+972598082061","970598082061","972598082061","00970598082061","00972598082061","0598082061"]) {
      expect(variants.has(expected)).toBe(true);
    }
  });
  it.each(["+970569000000","00970569000000","0569000000","+972569000000","00972569000000"])("supports 056 format %s", (value) => {
    const variants = new Set(phoneSearchVariants(value));
    expect(variants.has("0569000000")).toBe(true);
    expect(variants.has("+970569000000")).toBe(true);
    expect(variants.has("+972569000000")).toBe(true);
  });
});
