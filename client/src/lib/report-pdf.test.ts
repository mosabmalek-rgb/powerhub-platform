import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("keeps Payroll, Operations, and Reports HTML interpolation escaped or DOM-based", () => {
    const payroll = readFileSync(resolve(process.cwd(), "client/src/pages/PayrollPage.tsx"), "utf8");
    const operations = readFileSync(resolve(process.cwd(), "client/src/pages/OperationsPage.tsx"), "utf8");
    const reports = readFileSync(resolve(process.cwd(), "client/src/pages/ReportsPage.tsx"), "utf8");

    expect(payroll).toContain("escapeHtml(run.period)");
    expect(payroll).toContain("escapeHtml(selectedRun?.period ?? period)");
    expect(operations).toContain("escapeHtml(paymentStartDate || \"كل الفترات\")");
    expect(operations).toContain("escapeHtml(paymentEndDate || \"كل الفترات\")");
    expect(reports).not.toContain("${pdfRef.current.innerHTML}");
    expect(reports).toContain("pdfRef.current.cloneNode(true)");
  });
});
