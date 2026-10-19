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
    expect(operations).toContain('escapeHtml(paymentPeriod === "today" ? "اليوم"');
    expect(operations).toContain("escapeHtml(siteName)");
    expect(operations).toContain("escapeHtml(cell)");
    expect(reports).not.toContain("${pdfRef.current.innerHTML}");
    expect(reports).toContain("pdfRef.current.cloneNode(true)");
  });
});

describe("PDF table layout", () => {
  it("adds a visible four-sided border and readable padding to every header and data cell", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/lib/report-pdf.ts"), "utf8");
    expect(source).toContain('report.querySelectorAll<HTMLElement>("th, td")');
    expect(source).toContain('cell.style.border = "1px solid #9CA8B7"');
    expect(source).toContain('cell.style.padding = "9px 11px"');
    expect(source).toContain('table.style.borderCollapse = "collapse"');
    expect(source).toContain("element.cloneNode(true)");
    expect(source).toContain("host.remove()");
  });
});
