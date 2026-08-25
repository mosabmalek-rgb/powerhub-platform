// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildPaymentMethodCsv, buildPaymentMethodWorkbook, PaymentMethodCollectionSummary, summarizePaymentMethods } from "./PaymentMethodCollectionSummary";

describe("PaymentMethodCollectionSummary", () => {
  const payments = [
    { payment: { status: "completed", paymentMethod: "cash", amount: "40" } },
    { payment: { status: "completed", paymentMethod: "jawwal_pay", amount: "70" } },
    { payment: { status: "cancelled", paymentMethod: "cash", amount: "99" } },
  ];

  it("summarizes completed collections and filters them by payment method", () => {
    render(<PaymentMethodCollectionSummary payments={payments} />);
    expect(screen.getByText("ملخص التحصيل حسب طريقة الدفع")).toBeTruthy();
    expect(screen.getByText("110")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "jawwal_pay" } });
    expect(screen.getAllByText("70").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("40")).toBeNull();
  });

  it("builds a UTF-8 CSV report that Excel can read for the active filter", () => {
    const summary = summarizePaymentMethods(payments, "jawwal_pay");
    const csv = buildPaymentMethodCsv(summary.groups, summary.total, "jawwal_pay");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("ملخص التحصيلات حسب طريقة الدفع");
    expect(csv).toContain("Jawwal Pay");
    expect(csv).toContain("70.00");
    expect(csv).not.toContain("40.00");
  });

  it("filters the summary and exported report by the selected paid-at date range", () => {
    const datedPayments = [
      { payment: { status: "completed", paymentMethod: "cash", amount: "40", paidAt: "2026-08-01T10:00:00.000Z" } },
      { payment: { status: "completed", paymentMethod: "jawwal_pay", amount: "70", paidAt: "2026-09-01T10:00:00.000Z" } },
    ];
    const summary = summarizePaymentMethods(datedPayments, "all", { from: "2026-09-01", to: "2026-09-30" });
    expect(summary.total).toBe(70);
    const csv = buildPaymentMethodCsv(summary.groups, summary.total, "all", { from: "2026-09-01", to: "2026-09-30" });
    expect(csv).toContain("2026-09-01 إلى 2026-09-30");
    expect(csv).not.toContain("40.00");
  });

  it("builds a styled Excel workbook with summary and payment-detail sheets", () => {
    const summary = summarizePaymentMethods(payments, "jawwal_pay");
    const workbook = buildPaymentMethodWorkbook(summary.groups, summary.total, "jawwal_pay", {}, [{ payment: { paymentNo: "PAY-1", paymentMethod: "jawwal_pay", amount: "70", paidAt: "2026-08-01", receiptImageUrl: "https://storage.example.test/signed-receipt" }, subscriber: { fullName: "محمد أحمد" }, invoiceNo: "INV-1" }], "https://powerhub.example");
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["ملخص التحصيل", "تفاصيل الدفعات"]);
    const summarySheet = workbook.getWorksheet("ملخص التحصيل")!;
    expect(summarySheet.getCell("A1").value).toContain("PowerHub");
    expect(summarySheet.getCell("A5").fill).toBeTruthy();
    const detailsSheet = workbook.getWorksheet("تفاصيل الدفعات")!;
    expect(detailsSheet.getCell("A3").value).toBe("PAY-1");
    expect(detailsSheet.getCell("C3").value).toBe("محمد أحمد");
    expect((detailsSheet.getCell("H3").value as { hyperlink: string }).hyperlink).toBe("https://storage.example.test/signed-receipt");
    expect(detailsSheet.getCell("A4").value).toBe("إجمالي فرعي — Jawwal Pay");
    expect(detailsSheet.getCell("A5").value).toBe("الإجمالي العام");
    expect(detailsSheet.getCell("E5").value).toBe(70);
  });
});
