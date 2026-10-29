import type { QueuedOfflineWork } from "./offline-work-queue";

export type OfflineSyncRefreshTarget =
  | "subscribers"
  | "subscriber-quota"
  | "generators"
  | "readings"
  | "invoices"
  | "invoice-pages"
  | "payments"
  | "payment-documentation"
  | "dashboard-summary"
  | "financial-dashboard"
  | "audit"
  | "hr-directory"
  | "hr-attendance"
  | "payroll"
  | "employee-advances"
  | "fuel";

export type OfflineSyncRefreshCandidate = {
  item: Pick<QueuedOfflineWork, "kind" | "payload">;
  outcome: string;
};

const SUCCESS_OUTCOMES = new Set(["applied", "already_applied"]);

const TARGETS_BY_KIND: Partial<Record<QueuedOfflineWork["kind"], readonly OfflineSyncRefreshTarget[]>> = {
  subscriber_create: ["subscribers", "subscriber-quota", "dashboard-summary"],
  subscriber_update: ["subscribers", "subscriber-quota", "dashboard-summary"],
  generator_create: ["generators"],
  generator_update: ["generators"],
  // Offline fuel fill is an intent; its server RPC owns all ledger changes.
  fuel_fill: ["fuel", "generators"],
  // The server creates and approves the reading and issues its invoice in one RPC.
  // Refresh the related invoice and financial summaries only after that RPC confirms success.
  reading_create: ["readings", "invoices", "invoice-pages", "dashboard-summary", "financial-dashboard"],
  invoice_issue: ["invoices", "invoice-pages", "dashboard-summary", "financial-dashboard"],
  payment_create: ["payments", "invoices", "dashboard-summary", "financial-dashboard"],
  payment_documentation_submit: ["payment-documentation"],
  payment_documentation_approve: ["payment-documentation", "payments", "invoices", "invoice-pages", "dashboard-summary", "financial-dashboard"],
  employee_create: ["hr-directory", "payroll", "employee-advances"],
  employee_update: ["hr-directory", "payroll"],
  attendance_upsert: ["hr-attendance"],
  payroll_draft: ["payroll"],
  employee_advance_issue: ["employee-advances", "payroll", "financial-dashboard", "dashboard-summary"],
  employee_advance_repayment: ["employee-advances", "payroll", "financial-dashboard", "dashboard-summary"],
};

/**
 * Computes the minimum safe Query invalidation set after outbox replay.
 * Only server-confirmed success can invalidate data; pending, rejected,
 * conflicted, and retryable operations must not make stale data look refreshed.
 */
export function getOfflineSyncRefreshTargets(
  results: readonly OfflineSyncRefreshCandidate[],
): OfflineSyncRefreshTarget[] {
  const targets = new Set<OfflineSyncRefreshTarget>();
  for (const result of results) {
    if (!SUCCESS_OUTCOMES.has(result.outcome)) continue;
    for (const target of TARGETS_BY_KIND[result.item.kind] ?? []) targets.add(target);
    if (result.item.kind === "subscriber_create" && typeof result.item.payload === "object" && result.item.payload !== null &&
        "openingReading" in result.item.payload && Boolean(result.item.payload.openingReading)) {
      // An opening baseline is created with the subscriber but does not issue an invoice.
      targets.add("readings");
    }
  }
  if (targets.size > 0) targets.add("audit");
  return [...targets];
}
