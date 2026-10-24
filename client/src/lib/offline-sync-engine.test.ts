import { describe, expect, it } from "vitest";
import type { QueuedOfflineWork } from "./offline-work-queue";
import {
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

  it("does not plan operations before nextAttemptAt", () => {
    const a = item("a", 100);
    const metadata = new Map([["a", { ...createSyncMetadata(a, 0), nextAttemptAt: 500 }]]);
    expect(planReadyOperations([a], metadata, new Set(), 499)).toHaveLength(0);
    expect(planReadyOperations([a], metadata, new Set(), 500)).toHaveLength(1);
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

  it("marks completed operations as terminal", () => {
    const a = item("a", 100);
    const completed = markCompleted(createSyncMetadata(a, 0));
    expect(completed.nextAttemptAt).toBe(Number.POSITIVE_INFINITY);
    expect(completed.lastError).toBeUndefined();
  });
});
