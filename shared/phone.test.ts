import { describe, expect, it } from "vitest";
import { normalizeInternationalPhone } from "./phone";

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

  it("accepts 970, 972, and 00-prefixed country codes", () => {
    expect(normalizeInternationalPhone("970599000000")).toBe("+970599000000");
    expect(normalizeInternationalPhone("+972599000000")).toBe("+970599000000");
    expect(normalizeInternationalPhone("00972569000000")).toBe("+970569000000");
  });
});
