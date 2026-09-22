import { describe, expect, it } from "vitest";
import { escapeHtml } from "./report-pdf";

describe("escapeHtml", () => {
  it("escapes HTML metacharacters before PDF report interpolation", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)"> & \'quoted\'')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;",
    );
  });

  it("handles nullish values deterministically", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(123)).toBe("123");
  });
});
