import { describe, expect, it } from "vitest";
import { calculateInvoiceAmounts, hashInvoiceShareToken, nextInvoiceNo } from "./powerhub-utils";

describe("PowerHub financial utilities", () => {
  it("calculates invoice totals including fixed fee, tax and discount", () => {
    expect(calculateInvoiceAmounts({ consumptionKwh: 120, pricePerKwh: 0.5, fixedFee: 5, taxRate: 10, discountAmount: 3 }))
      .toEqual({ energyAmount: 60, subtotal: 65, taxAmount: 6.5, totalAmount: 68.5 });
  });

  it("creates a global annual invoice number independent of site", () => {
    expect(nextInvoiceNo("BAG-01", "2026-08", 1)).toBe("INV-2026-0001");
    expect(nextInvoiceNo("SITE-99", "2026-09", 12)).toBe("INV-2026-0012");
  });

  it("keeps invoice references distinct for sequence numbers", () => {
    const references = [1, 2, 3].map((sequence) => nextInvoiceNo("BAG-01", "2026-08", sequence));
    expect(new Set(references).size).toBe(3);
  });

  it("keeps the same sequence value globally regardless of site code", () => {
    expect(nextInvoiceNo("BAG-01", "2026-08", 7)).toBe(nextInvoiceNo("OTHER-SITE", "2026-08", 7));
  });

  it("hashes share tokens without returning their raw value", () => {
    expect(hashInvoiceShareToken("shared-token")).not.toContain("shared-token");
    expect(hashInvoiceShareToken("shared-token")).toBe(hashInvoiceShareToken("shared-token"));
  });
});
