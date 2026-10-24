import { describe, expect, it } from "vitest";
import type { QueuedOfflineWork } from "./offline-work-queue";
import { getOfflineSyncRefreshTargets } from "./offline-sync-refresh";

function result(kind: QueuedOfflineWork["kind"], outcome: string) {
  return {
    item: { kind } as Pick<QueuedOfflineWork, "kind">,
    outcome,
  };
}

describe("offline sync Query invalidation plan", () => {
  it("does not invalidate anything when the server has not confirmed a mutation", () => {
    expect(getOfflineSyncRefreshTargets([
      result("subscriber_create", "pending"),
      result("payment_create", "retryable"),
      result("invoice_issue", "conflict"),
      result("reading_create", "rejected"),
    ])).toEqual([]);
  });

  it("refreshes subscriber data and quota only after subscriber create/update succeeds", () => {
    expect(getOfflineSyncRefreshTargets([
      result("subscriber_create", "applied"),
      result("subscriber_update", "already_applied"),
    ])).toEqual(["subscribers", "subscriber-quota", "dashboard-summary", "audit"]);
  });

  it("keeps generator and reading changes out of unrelated financial queries", () => {
    expect(getOfflineSyncRefreshTargets([
      result("generator_update", "applied"),
      result("reading_create", "applied"),
    ])).toEqual(["generators", "readings", "audit"]);
  });

  it("deduplicates targets when a batch contains multiple financial operations", () => {
    expect(getOfflineSyncRefreshTargets([
      result("invoice_issue", "applied"),
      result("payment_create", "already_applied"),
      result("payment_documentation_submit", "rejected"),
    ])).toEqual([
      "invoices",
      "invoice-pages",
      "dashboard-summary",
      "financial-dashboard",
      "payments",
      "audit",
    ]);
  });
});
