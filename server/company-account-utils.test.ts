import { describe, expect, it } from "vitest";
import { calculateCompanyAccountBalance } from "./company-account-utils";

describe("calculateCompanyAccountBalance", () => {
  it("يحتسب الرصيد الافتتاحي مع الإيداعات والتحصيلات والسحوبات والتحويلات", () => {
    const balance = calculateCompanyAccountBalance("1000", [
      { transactionType: "deposit", amount: "250" },
      { transactionType: "collection", amount: "125" },
      { transactionType: "withdrawal", amount: "300" },
      { transactionType: "transfer_out", amount: "150" },
      { transactionType: "transfer_in", amount: "75" },
    ]);

    expect(balance).toBe(1000);
  });

  it("يتعامل بأمان مع الرصيد أو المبلغ غير القابل للتحويل إلى رقم", () => {
    expect(calculateCompanyAccountBalance("not-a-number", [{ transactionType: "deposit", amount: "bad" }])).toBe(0);
  });
});
