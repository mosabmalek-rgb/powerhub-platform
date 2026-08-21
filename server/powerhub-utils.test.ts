import { describe, expect, it } from "vitest";
import { calculateInvoiceAmounts, hashInvoiceShareToken, nextInvoiceNo } from "./powerhub-utils";

describe("PowerHub financial utilities", () => {
  it("calculates invoice totals including fixed fee, tax and discount", () => {
    expect(calculateInvoiceAmounts({ consumptionKwh: 120, pricePerKwh: 0.5, fixedFee: 5, taxRate: 10, discountAmount: 3 }))
      .toEqual({ energyAmount: 60, subtotal: 65, taxAmount: 6.5, totalAmount: 68.5 });
  });

  it("creates predictable invoice numbers for a site and period", () => {
    expect(nextInvoiceNo("BAG-01", "2026-08", 12)).toBe("PH-BAG-01-202608-00012");
  });

  it("keeps the invoice reference distinct for every sequence number", () => {
    const references = [1, 2, 3].map((sequence) => nextInvoiceNo("BAG-01", "2026-08", sequence));
    expect(new Set(references).size).toBe(3);
  });

  it("hashes share tokens without returning their raw value", () => {
    expect(hashInvoiceShareToken("shared-token")).not.toContain("shared-token");
    expect(hashInvoiceShareToken("shared-token")).toBe(hashInvoiceShareToken("shared-token"));
  });
});
