import { describe, expect, it } from "vitest";
import { normalizeInternationalPhone } from "./phone";

describe("international phone normalization", () => {
  it("keeps an E.164 number and removes readable separators", () => {
    expect(normalizeInternationalPhone("+970 599-000-000")).toBe("+970599000000");
  });

  it("converts the 00 prefix to an international plus prefix", () => {
    expect(normalizeInternationalPhone("00970599000000")).toBe("+970599000000");
  });

  it("rejects a local number when its country cannot be determined safely", () => {
    expect(() => normalizeInternationalPhone("0599000000")).toThrow(/E.164/);
  });
});
