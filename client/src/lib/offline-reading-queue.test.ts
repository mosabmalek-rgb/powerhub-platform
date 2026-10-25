import { describe, expect, it } from "vitest";
import { SYNC_MAX_ATTEMPTS } from "./offline-sync-engine";
import { isQueuedReadingReadyForSync, type QueuedReading } from "./offline-reading-queue";

function reading(overrides: Partial<QueuedReading> = {}): QueuedReading {
  return {
    id: "reading-1",
    clientOperationId: "reading-op-1",
    userId: 7,
    tenantId: 2,
    siteId: 3,
    subscriberId: 31,
    readingValue: "1234",
    readingAt: "2026-10-25T10:00:00.000Z",
    captureMethod: "manual",
    createdAt: 100,
    status: "pending",
    attempts: 0,
    nextAttemptAt: 100,
    ...overrides,
  };
}

describe("offline reading sync readiness", () => {
  it("does not automatically replay an exhausted ambiguous send, but enables explicit recovery", () => {
    const stuck = reading({
      status: "failed",
      attempts: SYNC_MAX_ATTEMPTS,
      nextAttemptAt: 1,
      syncOutcome: "syncing",
      lastErrorKind: "retryable",
    });
    expect(isQueuedReadingReadyForSync(stuck, 200)).toBe(false);
    expect(isQueuedReadingReadyForSync(stuck, 200, true)).toBe(true);
  });

  it("resumes syncing operations below the attempt ceiling", () => {
    const resumable = reading({ attempts: SYNC_MAX_ATTEMPTS - 1, syncOutcome: "syncing" });
    expect(isQueuedReadingReadyForSync(resumable, 200)).toBe(true);
  });

  it("does not bypass backoff for ordinary transient failures", () => {
    const delayed = reading({
      status: "failed",
      attempts: 1,
      nextAttemptAt: 500,
      syncOutcome: "retryable",
      lastErrorKind: "retryable",
    });
    expect(isQueuedReadingReadyForSync(delayed, 200)).toBe(false);
    expect(isQueuedReadingReadyForSync(delayed, 200, true)).toBe(false);
  });
});
