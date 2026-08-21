// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaymentMethodCollectionSummary } from "./PaymentMethodCollectionSummary";

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
    fireEvent.change(screen.getByLabelText("فلتر طريقة الدفع"), { target: { value: "jawwal_pay" } });
    expect(screen.getAllByText("70").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("40")).toBeNull();
  });
});
