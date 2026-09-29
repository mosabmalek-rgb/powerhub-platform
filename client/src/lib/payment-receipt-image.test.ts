import { describe, expect, it } from "vitest";
import {
  PAYMENT_RECEIPT_IMAGE_MAX_DIMENSION,
  PAYMENT_RECEIPT_IMAGE_QUALITY,
  preparePaymentReceiptImage,
} from "./payment-receipt-image";

describe("payment receipt image preparation", () => {
  it("uses a bounded dimension and compression policy", () => {
    expect(PAYMENT_RECEIPT_IMAGE_MAX_DIMENSION).toBe(1600);
    expect(PAYMENT_RECEIPT_IMAGE_QUALITY).toBe(0.78);
  });

  it("rejects non-image input", async () => {
    const file = new File(["hello"], "receipt.txt", { type: "text/plain" });
    await expect(preparePaymentReceiptImage(file)).rejects.toThrow("ليس صورة");
  });
});
