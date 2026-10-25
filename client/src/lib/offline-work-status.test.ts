import { describe, expect, it } from "vitest";
import type { QueuedOfflineWork } from "./offline-work-queue";
import type { SyncMetadataRecord } from "./offline-sync-metadata";
import { getOfflineWorkStatusPresentation } from "./offline-work-status";
import { SYNC_MAX_ATTEMPTS } from "./offline-sync-engine";

type WorkState = Pick<QueuedOfflineWork, "clientOperationId" | "userId" | "tenantId" | "siteId" | "kind" | "status">;

function item(status: WorkState["status"] = "pending", tenantId = 20): WorkState {
  return {
    clientOperationId: "offline-op-1",
    userId: 7,
    tenantId,
    siteId: 10,
    kind: "payment_create",
    status,
  };
}

function metadata(
  outcome: SyncMetadataRecord["outcome"],
  overrides: Partial<SyncMetadataRecord> = {},
): SyncMetadataRecord {
  return {
    operationId: "offline-op-1",
    userId: 7,
    tenantId: 20,
    siteId: 10,
    kind: "payment_create",
    dependsOn: [],
    attempts: 1,
    nextAttemptAt: 100,
    outcome,
    updatedAt: 100,
    ...overrides,
  };
}

describe("offline work status presentation", () => {
  it("distinguishes server-confirmed success from replayed success", () => {
    const applied = getOfflineWorkStatusPresentation(item("applied"), metadata("applied"), 200);
    const replayed = getOfflineWorkStatusPresentation(item("applied"), metadata("already_applied"), 200);
    expect(applied.label).toContain("أكد الخادم نجاح");
    expect(replayed.label).toContain("نُفذت سابقًا");
    expect(applied.tone).toBe("success");
    expect(replayed.tone).toBe("success");
  });

  it("offers retry only for a scope-matched retryable failure", () => {
    const retryable = getOfflineWorkStatusPresentation(item("failed"), metadata("retryable"), 200);
    const rejected = getOfflineWorkStatusPresentation(item("failed"), metadata("rejected"), 200);
    expect(retryable.canSync).toBe(true);
    expect(retryable.canRetry).toBe(true);
    expect(rejected.canSync).toBe(false);
    expect(rejected.canRetry).toBe(false);
    expect(rejected.label).toContain("رفض الخادم");
  });

  it("fails closed when persisted metadata belongs to another tenant", () => {
    const presentation = getOfflineWorkStatusPresentation(
      item("failed", 21),
      metadata("retryable"),
      200,
    );
    expect(presentation.outcome).toBe("missing");
    expect(presentation.canSync).toBe(false);
    expect(presentation.label).toContain("غير موثوقة");
  });

  it("offers local state reconciliation without replay when a terminal result is ahead of queue status", () => {
    const presentation = getOfflineWorkStatusPresentation(
      item("pending"),
      metadata("rejected"),
      200,
    );
    expect(presentation.outcome).toBe("rejected");
    expect(presentation.canSync).toBe(true);
    expect(presentation.actionLabel).toBe("تسوية الحالة");
  });

  it("offers an explicit recovery action for an exhausted ambiguous send", () => {
    const exhausted = getOfflineWorkStatusPresentation(
      item("pending"),
      metadata("syncing", { attempts: SYNC_MAX_ATTEMPTS }),
      200,
    );
    expect(exhausted.outcome).toBe("recoverable-syncing");
    expect(exhausted.canSync).toBe(true);
    expect(exhausted.canRetry).toBe(true);
    expect(exhausted.actionLabel).toBe("استعادة النتيجة");

    const notExhausted = getOfflineWorkStatusPresentation(
      item("pending"),
      metadata("syncing", { attempts: SYNC_MAX_ATTEMPTS - 1 }),
      200,
    );
    expect(notExhausted.outcome).toBe("syncing");
    expect(notExhausted.canRetry).toBe(false);
  });

  it("does not expose retry before nextAttemptAt for pending transient results", () => {
    const presentation = getOfflineWorkStatusPresentation(
      item("pending"),
      metadata("retryable", { nextAttemptAt: 300 }),
      200,
    );
    expect(presentation.canSync).toBe(false);
  });
});
