import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const supabase = read("server/powerhub-supabase.ts");
const router = read("server/powerhub.ts");
const page = read("client/src/pages/ReportsPage.tsx");
const offlineCache = read("client/src/lib/offline-report-cache.ts");
const reportReads = supabase.slice(
  supabase.indexOf("export async function listSupabaseReportPayments"),
  supabase.indexOf("export async function listSupabaseReportExpenses"),
);
const reportRoutes = router.slice(router.indexOf("  reports: router({"), router.indexOf("  reportBranding: router({"));

describe("financial report payment amount semantics", () => {
  it("selects and maps gross receipts, invoice applications and subscriber credit independently", () => {
    expect(reportReads).toContain("amount, invoice_applied_amount, subscriber_credit_amount");
    expect(reportReads).toContain("grossAmount: String(row.amount ?? 0)");
    expect(reportReads).toContain("invoiceAppliedAmount: String(row.invoice_applied_amount ?? 0)");
    expect(reportReads).toContain("subscriberCreditAmount: String(row.subscriber_credit_amount ?? 0)");
    expect(reportReads).toContain('.in("payment_purpose", ["invoice_collection", "invoice_collection_with_credit", "subscriber_credit"])');
  });

  it("keeps operating collections and profit on invoice-applied amounts", () => {
    expect(reportRoutes).toContain("Number(row.payment.invoiceAppliedAmount)");
    expect(reportRoutes).toContain("operatingProfit: collected - expenseTotal");
    expect(reportRoutes).not.toContain("operatingProfit: grossCollected - expenseTotal");
  });

  it("exposes receipt cash and credit separately in branch, all-branch and monthly reports", () => {
    expect(reportRoutes).toContain("grossCollected");
    expect(reportRoutes).toContain("subscriberCreditCreated");
    expect(reportRoutes).toContain("grossAmount: Number(payment.grossAmount)");
    expect(reportRoutes).toContain("invoiceAppliedAmount: Number(payment.invoiceAppliedAmount)");
    expect(reportRoutes).toContain("subscriberCreditAmount: Number(payment.subscriberCreditAmount)");
  });

  it("labels and exports cash, invoice application and credit as separate figures", () => {
    for (const label of ["النقد المقبوض", "المطبق على الفواتير", "الرصيد الدائن المنشأ"]) {
      expect(page).toContain(label);
    }
    expect(page).toContain("payment.grossAmount");
    expect(page).toContain("payment.invoiceAppliedAmount");
    expect(page).toContain("payment.subscriberCreditAmount");
    expect(page).toContain("payment.grossAmount; return totals");
  });

  it("keeps safe aggregate totals in the offline report cache but excludes receipt details", () => {
    expect(offlineCache).toContain('for (const key of ["range", "summary", "scope", "branchSummaries"] as const)');
    const payloadProjection = offlineCache.slice(
      offlineCache.indexOf("export function createOfflineReportSnapshotPayload"),
      offlineCache.indexOf("export type ReportSnapshotScope"),
    );
    expect(payloadProjection).not.toContain("paymentDetails");
    expect(payloadProjection).not.toContain("collectors");
  });

  it("rolls gross cash and subscriber credit into the all-branch summary", () => {
    expect(reportRoutes).toContain("grossCollected: total.grossCollected + branch.grossCollected");
    expect(reportRoutes).toContain("subscriberCreditCreated: total.subscriberCreditCreated + branch.subscriberCreditCreated");
    expect(reportRoutes).toContain("grossCollected: 0, subscriberCreditCreated: 0");
  });

  it("counts only completed monthly payments for collector performance", () => {
    expect(reportRoutes).toContain("const completedPayments = periodPayments.filter((row) => row.payment.status === \"completed\")");
    expect(reportRoutes).toContain("completedPayments.reduce<Record<string, { name: string; count: number; amount: number; grossAmount: number; subscriberCreditAmount: number }>>");
  });
});
