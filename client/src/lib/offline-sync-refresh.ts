import type { QueuedOfflineWork } from "./offline-work-queue";

export type OfflineSyncRefreshTarget =
  | "subscribers"
  | "subscriber-quota"
  | "generators"
  | "readings"
  | "invoices"
  | "invoice-pages"
  | "payments"
  | "dashboard-summary"
  | "financial-dashboard"
  | "audit";

export type OfflineSyncRefreshCandidate = {
  item: Pick<QueuedOfflineWork, "kind">;
  outcome: string;
};

const SUCCESS_OUTCOMES = new Set(["applied", "already_applied"]);

const TARGETS_BY_KIND: Partial<Record<QueuedOfflineWork["kind"], readonly OfflineSyncRefreshTarget[]>> = {
  subscriber_create: ["subscribers", "subscriber-quota", "dashboard-summary"],
  subscriber_update: ["subscribers", "subscriber-quota", "dashboard-summary"],
  generator_create: ["generators"],
  generator_update: ["generators"],
  reading_create: ["readings"],
  invoice_issue: ["invoices", "invoice-pages", "dashboard-summary", "financial-dashboard"],
  payment_create: ["payments", "invoices", "dashboard-summary", "financial-dashboard"],
  payment_documentation_submit: ["payments", "invoices", "dashboard-summary", "financial-dashboard"],
  payment_documentation_approve: ["payments", "invoices", "dashboard-summary", "financial-dashboard"],
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
  }
  if (targets.size > 0) targets.add("audit");
  return [...targets];
}
