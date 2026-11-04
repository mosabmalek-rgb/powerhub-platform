export type SettlementLedgerBreakdown = {
  snapshotVersion: number | null;
  capturedAt: string | null;
  subscriberCreditCreated: number | null;
  securityDepositReceived: number | null;
  securityDepositRefunded: number | null;
  supplierPaymentAmount: number | null;
  supplierPurchaseInvoiceAmount: number | null;
  supplierReturnCreditAmount: number | null;
  supplierReturnRefundAmount: number | null;
  operatingExpensesByCategory: Partial<Record<"fuel" | "maintenance" | "payroll" | "parts" | "transport" | "other", number>>;
  cashBreakdown: {
    inflows: {
      subscriberCollections: number | null;
      otherCollections: number | null;
      securityDepositReceipts: number | null;
      supplierReturnRefunds: number | null;
      otherDeposits: number | null;
      transfersIn: number | null;
      accountOpeningBalanceAdded: number | null;
    };
    outflows: {
      operatingExpenses: number | null;
      supplierPayments: number | null;
      securityDepositRefunds: number | null;
      otherPaymentRefunds: number | null;
      otherWithdrawals: number | null;
      transfersOut: number | null;
    };
  } | null;
  reconciliation: {
    paymentCashMismatchCount: number | null;
    expenseCashMismatchCount: number | null;
    supplierPaymentCashMismatchCount: number | null;
    supplierReturnCashMismatchCount: number | null;
    unlinkedAccountMovementCount: number | null;
    orphanReferenceMovementCount: number | null;
    unallocatedSharedOpeningBalance: number | null;
    issueCount: number | null;
    status: "reconciled" | "attention_required" | null;
  } | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numericRecord<K extends string>(source: Record<string, unknown> | null, keys: readonly K[]): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const value = finiteNumberOrNull(source?.[key]);
    if (value !== null) result[key] = value;
  }
  return result;
}

/**
 * Return only the documented financial fields from a historical settlement snapshot.
 * In particular, do not expose its source fingerprint or arbitrary JSON properties.
 */
export function normalizeSettlementLedgerSnapshot(value: unknown): SettlementLedgerBreakdown | null {
  const snapshot = asRecord(value);
  if (!snapshot) return null;

  const cash = asRecord(snapshot.cashBreakdown);
  const inflows = asRecord(cash?.inflows);
  const outflows = asRecord(cash?.outflows);
  const reconciliation = asRecord(snapshot.reconciliation);
  const expenses = asRecord(snapshot.operatingExpensesByCategory);
  const allowedExpenseCategories = ["fuel", "maintenance", "payroll", "parts", "transport", "other"] as const;
  const expenseValues = numericRecord(expenses, allowedExpenseCategories);

  const reconciliationStatus = reconciliation?.status === "reconciled" || reconciliation?.status === "attention_required"
    ? reconciliation.status
    : null;
  const snapshotVersion = finiteNumberOrNull(snapshot.snapshotVersion);

  return {
    snapshotVersion: snapshotVersion === null ? null : Math.trunc(snapshotVersion),
    capturedAt: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : null,
    subscriberCreditCreated: finiteNumberOrNull(snapshot.subscriberCreditCreated),
    securityDepositReceived: finiteNumberOrNull(snapshot.securityDepositReceived),
    securityDepositRefunded: finiteNumberOrNull(snapshot.securityDepositRefunded),
    supplierPaymentAmount: finiteNumberOrNull(snapshot.supplierPaymentAmount),
    supplierPurchaseInvoiceAmount: finiteNumberOrNull(snapshot.supplierPurchaseInvoiceAmount),
    supplierReturnCreditAmount: finiteNumberOrNull(snapshot.supplierReturnCreditAmount),
    supplierReturnRefundAmount: finiteNumberOrNull(snapshot.supplierReturnRefundAmount),
    operatingExpensesByCategory: expenseValues,
    cashBreakdown: cash ? {
      inflows: {
        subscriberCollections: finiteNumberOrNull(inflows?.subscriberCollections),
        otherCollections: finiteNumberOrNull(inflows?.otherCollections),
        securityDepositReceipts: finiteNumberOrNull(inflows?.securityDepositReceipts),
        supplierReturnRefunds: finiteNumberOrNull(inflows?.supplierReturnRefunds),
        otherDeposits: finiteNumberOrNull(inflows?.otherDeposits),
        transfersIn: finiteNumberOrNull(inflows?.transfersIn),
        accountOpeningBalanceAdded: finiteNumberOrNull(inflows?.accountOpeningBalanceAdded),
      },
      outflows: {
        operatingExpenses: finiteNumberOrNull(outflows?.operatingExpenses),
        supplierPayments: finiteNumberOrNull(outflows?.supplierPayments),
        securityDepositRefunds: finiteNumberOrNull(outflows?.securityDepositRefunds),
        otherPaymentRefunds: finiteNumberOrNull(outflows?.otherPaymentRefunds),
        otherWithdrawals: finiteNumberOrNull(outflows?.otherWithdrawals),
        transfersOut: finiteNumberOrNull(outflows?.transfersOut),
      },
    } : null,
    reconciliation: reconciliation ? {
      paymentCashMismatchCount: finiteNumberOrNull(reconciliation.paymentCashMismatchCount),
      expenseCashMismatchCount: finiteNumberOrNull(reconciliation.expenseCashMismatchCount),
      supplierPaymentCashMismatchCount: finiteNumberOrNull(reconciliation.supplierPaymentCashMismatchCount),
      supplierReturnCashMismatchCount: finiteNumberOrNull(reconciliation.supplierReturnCashMismatchCount),
      unlinkedAccountMovementCount: finiteNumberOrNull(reconciliation.unlinkedAccountMovementCount),
      orphanReferenceMovementCount: finiteNumberOrNull(reconciliation.orphanReferenceMovementCount),
      unallocatedSharedOpeningBalance: finiteNumberOrNull(reconciliation.unallocatedSharedOpeningBalance),
      issueCount: finiteNumberOrNull(reconciliation.issueCount),
      status: reconciliationStatus,
    } : null,
  };
}
