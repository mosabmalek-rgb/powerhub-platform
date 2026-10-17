import { describe, expect, it } from "vitest";
import { formatPreviewAmount, previewMessageTemplate } from "./message-template-preview";

describe("message-template monetary preview", () => {
  it("replaces tokens and limits all monetary variables to one decimal place", () => {
    const rendered = previewMessageTemplate(
      "الفاتورة {{total_amount}}، المتبقي {{ balance_due }}، الرصيد الإجمالي {{total_balance}}",
      false,
    );
    expect(rendered).toBe("الفاتورة 33,000.8، المتبقي 18,000.5، الرصيد الإجمالي 42,500.7");
    expect(rendered).not.toMatch(/\\d+\\.\\d{2,}/);
  });

  it("hides fractions when the settlement display policy is enabled", () => {
    expect(previewMessageTemplate("{{total_amount}}|{{balance_due}}|{{total_balance}}", true))
      .toBe("33,000|18,000|42,500");
  });

  it("formats decimal strings safely without converting through floating point", () => {
    expect(formatPreviewAmount("999.96", false)).toBe("1,000.0");
    expect(formatPreviewAmount("-10.55", false)).toBe("-10.6");
    expect(formatPreviewAmount("100000000000000000000.456", false)).toBe("100,000,000,000,000,000,000.5");
    expect(formatPreviewAmount("120.8", true)).toBe("120");
  });
});
