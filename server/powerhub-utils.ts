import crypto from "node:crypto";

export function calculateInvoiceAmounts(input: {
  consumptionKwh: number;
  pricePerKwh: number;
  fixedFee: number;
  taxRate: number;
  discountAmount: number;
}) {
  const energyAmount = Math.round(input.consumptionKwh * input.pricePerKwh * 100) / 100;
  const subtotal = Math.round((energyAmount + input.fixedFee) * 100) / 100;
  const taxAmount = Math.round(subtotal * (input.taxRate / 100) * 100) / 100;
  const totalAmount = Math.max(0, Math.round((subtotal + taxAmount - input.discountAmount) * 100) / 100);
  return { energyAmount, subtotal, taxAmount, totalAmount };
}

export function hashInvoiceShareToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Generates the human-readable PowerHub invoice number.
 * The invoice number is global at the business level; siteCode is retained
 * only for backward-compatible callers and is intentionally not encoded.
 * Example: INV-2026-0001
 */
export function nextInvoiceNo(_siteCode: string, period: string, sequence: number) {
  const year = period.slice(0, 4);
  return `INV-${year}-${String(sequence).padStart(4, "0")}`;
}
