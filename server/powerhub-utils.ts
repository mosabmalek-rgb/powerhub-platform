import crypto from "node:crypto";

export function calculateInvoiceAmounts(input: {
  consumptionKwh: number;
  pricePerKwh: number;
  fixedFee: number;
  taxRate: number;
  discountAmount: number;
}) {
  const energyAmount = input.consumptionKwh * input.pricePerKwh;
  const subtotal = energyAmount + input.fixedFee;
  const taxAmount = subtotal * (input.taxRate / 100);
  const totalAmount = Math.max(0, subtotal + taxAmount - input.discountAmount);

  return { energyAmount, subtotal, taxAmount, totalAmount };
}

export function generateInvoiceShareToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export function hashInvoiceShareToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function nextInvoiceNo(siteCode: string, period: string, sequence: number) {
  return `PH-${siteCode}-${period.replace("-", "")}-${String(sequence).padStart(5, "0")}`;
}
