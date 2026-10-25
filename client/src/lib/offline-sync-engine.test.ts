import { describe, expect, it } from "vitest";
import type { QueuedOfflineWork } from "./offline-work-queue";
import {
  canManuallyRetry,
  isManualSyncRecoveryRequired,
  SYNC_MAX_ATTEMPTS,
  classifySyncResult,
  computeBackoffDelay,
  createSyncMetadata,
  markCompleted,
  planReadyOperations,
  scheduleRetry,
  shouldRetry,
} from "./offline-sync-engine";

function item(clientOperationId: string, createdAt: number): QueuedOfflineWork {
  return {
    id: clientOperationId,
    clientOperationId,
    userId: 1,
    siteId: 7,
    kind: "subscriber_create",
    payload: { fullName: `User ${clientOperationId}`, phone: "0590000000", subscriptionType: "residential" },
    createdAt,
    updatedAt: createdAt,
    status: "pending",
  };
}

describe("offline sync engine", () => {
  it("plans only dependency-ready operations in creation order", () => {
    const a = item("a", 100);
    const b = item("b", 200);
    const meta = new Map([
      ["a", { ...createSyncMetadata(a, 0), dependsOn: [] }],
      ["b", { ...createSyncMetadata(b, 0), dependsOn: ["a"] }],
    ]);

    expect(planReadyOperations([b, a], meta, new Set(), 200).map(({ item: x }) => x.clientOperationId)).toEqual(["a"]);
    expect(planReadyOperations([b, a], meta, new Set(["a"]), 200).map(({ item: x }) => x.clientOperationId)).toEqual(["a", "b"]);
  });

  it("fails closed when persisted sync metadata is missing", () => {
    const queued = item("missing-metadata", 100);
    expect(planReadyOperations([queued], new Map(), new Set(), 100)).toEqual([]);
  });

  it("does not plan operations before nextAttemptAt", () => {
    const a = item("a", 100);
    const metadata = new Map([["a", { ...createSyncMetadata(a, 0), nextAttemptAt: 500 }]]);
    expect(planReadyOperations([a], metadata, new Set(), 499)).toHaveLength(0);
    expect(planReadyOperations([a], metadata, new Set(), 500)).toHaveLength(1);
  });

  it("never replays a terminal result when the queue row still says pending", () => {
    const outcomes = ["conflict", "rejected", "applied", "already_applied"] as const;
    for (const outcome of outcomes) {
      const queued = item(`terminal-${outcome}`, 100);
      const metadata = new Map([[queued.clientOperationId, {
        ...createSyncMetadata(queued, 0),
        outcome,
        nextAttemptAt: 0,
      }]]);
      expect(planReadyOperations([queued], metadata, new Set(), 100)).toEqual([]);
    }
  });

  it("recovers a persisted syncing operation after the prior tab crashed", () => {
    const queued = item("interrupted-sync", 100);
    const metadata = new Map([[queued.clientOperationId, {
      ...createSyncMetadata(queued, 0),
      outcome: "syncing" as const,
      attempts: 1,
      nextAttemptAt: Number.POSITIVE_INFINITY,
    }]]);
    expect(planReadyOperations([queued], metadata, new Set(), 100).map((entry) => entry.item.clientOperationId))
      .toEqual(["interrupted-sync"]);

    const exhausted = new Map([[queued.clientOperationId, {
      ...createSyncMetadata(queued, 0),
      outcome: "syncing" as const,
      attempts: 5,
      nextAttemptAt: Number.POSITIVE_INFINITY,
    }]]);
    expect(planReadyOperations([queued], exhausted, new Set(), 100)).toEqual([]);
  });

  it("plans a transient retry only when its retry window is due", () => {
    const queued = { ...item("retryable", 100), status: "failed" as const };
    const metadata = new Map([[queued.clientOperationId, {
      ...createSyncMetadata(queued, 0),
      outcome: "retryable" as const,
      attempts: 1,
      nextAttemptAt: 200,
    }]]);
    expect(planReadyOperations([queued], metadata, new Set(), 199)).toEqual([]);
    expect(planReadyOperations([queued], metadata, new Set(), 200)).toHaveLength(1);
  });

  it("allows manual retry only for an explicitly classified transient failure", () => {
    expect(canManuallyRetry(undefined)).toBe(false);
    expect(canManuallyRetry({ outcome: "pending" })).toBe(false);
    expect(canManuallyRetry({ outcome: "rejected" })).toBe(false);
    expect(canManuallyRetry({ outcome: "conflict" })).toBe(false);
    expect(canManuallyRetry({ outcome: "retryable" })).toBe(true);
  });

  it("classifies permanent auth and validation errors as rejected", () => {
    expect(classifySyncResult("UNAUTHORIZED")).toBe("rejected");
    expect(classifySyncResult("FORBIDDEN")).toBe("rejected");
    expect(classifySyncResult("VALIDATION_FAILED")).toBe("rejected");
  });

  it("does not automatically retry rejected preconditions such as quota limits", () => {
    expect(classifySyncResult("PRECONDITION_FAILED")).toBe("rejected");
  });

  it("classifies conflicts separately from transient failures", () => {
    expect(classifySyncResult("CONFLICT")).toBe("conflict");
    expect(classifySyncResult("SERVICE_UNAVAILABLE")).toBe("retryable");
  });

  it("fails closed for missing or unknown transport error codes", () => {
    expect(classifySyncResult(undefined)).toBe("retryable");
    expect(classifySyncResult("")).toBe("retryable");
    expect(classifySyncResult("UNKNOWN_ERROR")).toBe("retryable");
  });

  it("uses bounded exponential backoff with jitter", () => {
    expect(computeBackoffDelay(1, 0)).toBe(750);
    expect(computeBackoffDelay(2, 0.5)).toBe(2_000);
    expect(computeBackoffDelay(5, 1)).toBe(20_000);
    expect(computeBackoffDelay(20, 1)).toBeLessThanOrEqual(5 * 60_000);
  });

  it("stops automatic retries at the attempt ceiling", () => {
    const a = item("a", 100);
    const metadata = { ...createSyncMetadata(a, 0), attempts: 4 };
    const exhausted = scheduleRetry(metadata, 1_000, 0.5);
    expect(exhausted.attempts).toBe(5);
    expect(shouldRetry(exhausted)).toBe(false);
  });

  it("requires explicit recovery for a crash-stuck send after the retry ceiling", () => {
    expect(isManualSyncRecoveryRequired({ outcome: "syncing", attempts: SYNC_MAX_ATTEMPTS })).toBe(true);
    expect(isManualSyncRecoveryRequired({ outcome: "syncing", attempts: SYNC_MAX_ATTEMPTS - 1 })).toBe(false);
    expect(canManuallyRetry({ outcome: "syncing", attempts: SYNC_MAX_ATTEMPTS })).toBe(true);
    expect(canManuallyRetry({ outcome: "syncing", attempts: SYNC_MAX_ATTEMPTS - 1 })).toBe(false);
    expect(canManuallyRetry({ outcome: "retryable" })).toBe(true);
  });

  it("marks completed operations as terminal", () => {
    const a = item("a", 100);
    const completed = markCompleted(createSyncMetadata(a, 0));
    expect(completed.nextAttemptAt).toBe(Number.POSITIVE_INFINITY);
    expect(completed.lastError).toBeUndefined();
  });
});
