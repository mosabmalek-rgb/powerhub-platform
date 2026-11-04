import { describe, expect, it } from "vitest";
import { normalizeSettlementLedgerSnapshot } from "./financial-settlement-snapshot";

describe("normalizeSettlementLedgerSnapshot", () => {
  it("projects documented cash, liability and reconciliation fields from a saved snapshot", () => {
    const result = normalizeSettlementLedgerSnapshot({
      snapshotVersion: 1,
      capturedAt: "2026-11-04T12:00:00.000Z",
      sourceFingerprint: "must-not-leak",
      subscriberCreditCreated: "25.50",
      securityDepositReceived: 40,
      securityDepositRefunded: 5,
      supplierPaymentAmount: 12,
      supplierPurchaseInvoiceAmount: 90,
      supplierReturnCreditAmount: 8,
      supplierReturnRefundAmount: 3,
      operatingExpensesByCategory: { fuel: "10", maintenance: 5, unknown: 999 },
      cashBreakdown: {
        inflows: { subscriberCollections: "100", securityDepositReceipts: 40, transfersIn: 10 },
        outflows: { operatingExpenses: 20, supplierPayments: 12, securityDepositRefunds: 5 },
      },
      reconciliation: {
        paymentCashMismatchCount: 0, expenseCashMismatchCount: 1, issueCount: 1,
        status: "attention_required", internalDebug: "must-not-leak",
      },
      internalDebug: "must-not-leak",
    });

    expect(result).toMatchObject({
      snapshotVersion: 1,
      capturedAt: "2026-11-04T12:00:00.000Z",
      subscriberCreditCreated: 25.5,
      securityDepositReceived: 40,
      securityDepositRefunded: 5,
      supplierPaymentAmount: 12,
      supplierPurchaseInvoiceAmount: 90,
      supplierReturnCreditAmount: 8,
      supplierReturnRefundAmount: 3,
      operatingExpensesByCategory: { fuel: 10, maintenance: 5 },
      cashBreakdown: {
        inflows: { subscriberCollections: 100, securityDepositReceipts: 40, transfersIn: 10 },
        outflows: { operatingExpenses: 20, supplierPayments: 12, securityDepositRefunds: 5 },
      },
      reconciliation: { paymentCashMismatchCount: 0, expenseCashMismatchCount: 1, issueCount: 1, status: "attention_required" },
    });
    expect(result).not.toHaveProperty("sourceFingerprint");
    expect(result).not.toHaveProperty("internalDebug");
    expect(result?.reconciliation).not.toHaveProperty("internalDebug");
  });

  it("returns null for legacy settlements without a saved ledger snapshot", () => {
    expect(normalizeSettlementLedgerSnapshot(null)).toBeNull();
    expect(normalizeSettlementLedgerSnapshot(undefined)).toBeNull();
    expect(normalizeSettlementLedgerSnapshot("not-json")).toBeNull();
  });

  it("does not turn missing or invalid snapshot numbers into fabricated zeroes", () => {
    const result = normalizeSettlementLedgerSnapshot({
      subscriberCreditCreated: "not-a-number",
      cashBreakdown: { inflows: {}, outflows: {} },
      reconciliation: { status: "unknown" },
    });
    expect(result?.subscriberCreditCreated).toBeNull();
    expect(result?.cashBreakdown?.inflows.subscriberCollections).toBeNull();
    expect(result?.reconciliation?.status).toBeNull();
  });
});
