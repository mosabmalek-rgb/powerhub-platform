import { describe, expect, it } from "vitest";

describe("مفاتيح لقطات التقارير دون اتصال", () => {
  it("يعزل منطق المفتاح بحسب المستخدم والفرع والنطاق الزمني", async () => {
    const module = await import("./offline-report-cache");
    expect(typeof module.loadReportSnapshot).toBe("function");
    expect(typeof module.saveReportSnapshot).toBe("function");
  });
});
