import { describe, expect, it } from "vitest";
import { contrastRatio, meetsReadableContrast } from "./color-contrast";

describe("PowerHub color contrast", () => {
  it("meets readable contrast for light controls and status text", () => {
    expect(meetsReadableContrast("#17202b", "#ffffff")).toBe(true);
    expect(meetsReadableContrast("#166534", "#dcfce7")).toBe(true);
    expect(meetsReadableContrast("#92400e", "#fef3c7")).toBe(true);
    expect(meetsReadableContrast("#be123c", "#ffe4e6")).toBe(true);
    expect(meetsReadableContrast("#075985", "#e0f2fe")).toBe(true);
  });

  it("meets readable contrast for dark controls and status text", () => {
    expect(meetsReadableContrast("#f8fafc", "#1b222c")).toBe(true);
    expect(meetsReadableContrast("#86efac", "#123524")).toBe(true);
    expect(meetsReadableContrast("#fde68a", "#3b2b0b")).toBe(true);
    expect(meetsReadableContrast("#fda4af", "#3b1820")).toBe(true);
    expect(meetsReadableContrast("#7dd3fc", "#102d43")).toBe(true);
  });

  it("returns a stable ratio for black and white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});
