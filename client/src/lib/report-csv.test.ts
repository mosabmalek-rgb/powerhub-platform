import { describe, expect, it } from "vitest";
import { escapeCsvCell } from "./report-csv";

describe("financial CSV formula-injection protection", () => {
  it.each(["=1+1", "+cmd|' /C calc'!A0", "-1+1", "@SUM(A1:A2)", "  =HYPERLINK(\"https://example.invalid\")", "\t=1+1"])(
    "prefixes formula-like user text with a spreadsheet text marker: %s",
    (value) => {
      expect(escapeCsvCell(value)).toBe(`"'${value.replaceAll('"', '""')}"`);
    },
  );

  it("keeps negative numeric amounts numeric", () => {
    expect(escapeCsvCell(-125.5)).toBe('" -125.5"'.replace('" ', '"'));
    expect(escapeCsvCell(0)).toBe('"0"');
  });

  it("quotes cells and doubles embedded quote characters", () => {
    expect(escapeCsvCell('account "A"')).toBe('"account ""A"""');
    expect(escapeCsvCell("Ordinary branch")).toBe('"Ordinary branch"');
  });
});
