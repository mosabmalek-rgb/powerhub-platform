import { describe, expect, it } from "vitest";
import type { QueuedOfflineWork } from "./offline-work-queue";
import { getOfflineSyncRefreshTargets } from "./offline-sync-refresh";

function result(kind: QueuedOfflineWork["kind"], outcome: string, payload?: QueuedOfflineWork["payload"]) {
  return {
    item: { kind, payload: payload ?? {} } as Pick<QueuedOfflineWork, "kind" | "payload">,
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

  it("refreshes opening-reading baselines without incorrectly invalidating invoice data", () => {
    expect(getOfflineSyncRefreshTargets([
      result("subscriber_create", "applied", {
        fullName: "أحمد علي",
        phone: "+970599000000",
        subscriptionType: "residential",
        openingReading: "12.5",
      }),
    ])).toEqual(["subscribers", "subscriber-quota", "dashboard-summary", "readings", "audit"]);
  });

  it("keeps generator changes separate but refreshes invoices created by a synced reading", () => {
    expect(getOfflineSyncRefreshTargets([
      result("generator_update", "applied"),
    ])).toEqual(["generators", "audit"]);

    // The reading RPC atomically creates/approves the reading and issues an invoice.
    expect(getOfflineSyncRefreshTargets([
      result("reading_create", "applied"),
    ])).toEqual([
      "readings",
      "invoices",
      "invoice-pages",
      "dashboard-summary",
      "financial-dashboard",
      "audit",
    ]);
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
