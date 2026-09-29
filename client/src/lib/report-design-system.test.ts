import { describe, expect, it } from "vitest";
import { REPORT_METRICS, REPORT_PAYMENT_METHOD_LABELS, REPORT_PAYMENT_METHOD_OPTIONS, formatReportDate, formatReportPeriod } from "./report-design-system";

describe("report design system", () => {
  it("defines all supported payment methods with one canonical label", () => {
    expect(Object.keys(REPORT_PAYMENT_METHOD_LABELS)).toEqual([
      "cash",
      "jawwal_pay",
      "palpay",
      "bank_of_palestine",
      "wallet",
      "bank_transfer",
      "card",
    ]);
    expect(REPORT_PAYMENT_METHOD_OPTIONS[0]).toEqual({ value: "all", label: "كل طرق الدفع" });
  });

  it("uses canonical financial terminology", () => {
    expect(REPORT_METRICS.map((metric) => metric.label)).toEqual([
      "إجمالي الفوترة",
      "إجمالي التحصيل",
      "الأرصدة المستحقة",
      "إجمالي المصروفات",
      "صافي التدفق التشغيلي",
    ]);
  });

  it("formats Arabic Gregorian report dates consistently", () => {
    expect(formatReportDate("2026-09-20")).toContain("2026");
    expect(formatReportPeriod("2026-09-01", "2026-09-20")).toContain("—");
  });
});
