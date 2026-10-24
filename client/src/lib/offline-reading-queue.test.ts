import { describe, expect, it } from "vitest";
import {
  OfflineQueueError, assertOfflineQueueAvailable, classifyReadingSyncError,
  computeReadingRetryDelay, isQueuedReadingReadyForSync, scheduleReadingRetry, type QueuedReading,
} from "./offline-reading-queue";

describe("offline field reading adapter", () => {
  it("reports a clear error when IndexedDB is unavailable", () => {
    if (typeof indexedDB !== "undefined") return;
    expect(() => assertOfflineQueueAvailable()).toThrow(OfflineQueueError);
  });
  it("uses the shared sync outcome classifier", () => {
    expect(classifyReadingSyncError("CONFLICT")).toBe("conflict");
    expect(classifyReadingSyncError("BAD_REQUEST")).toBe("terminal");
    expect(classifyReadingSyncError("SERVICE_UNAVAILABLE")).toBe("retryable");
    expect(classifyReadingSyncError()).toBe("retryable");
  });
  it("applies bounded retry and respects retry deadlines", () => {
    const record: QueuedReading = {
      id: "reading-1", clientOperationId: "op-1", userId: 7, siteId: 3, subscriberId: 31,
      readingValue: "125.5", readingAt: "2026-10-24T10:00:00.000Z", captureMethod: "manual",
      createdAt: 1000, status: "failed", attempts: 1, nextAttemptAt: 5000, lastErrorKind: "retryable",
    };
    expect(isQueuedReadingReadyForSync(record, 4999)).toBe(false);
    expect(isQueuedReadingReadyForSync(record, 5000)).toBe(true);
    const retry = scheduleReadingRetry(record, 5000, 0.5);
    expect(retry.attempts).toBe(2);
    expect(retry.nextAttemptAt).toBeGreaterThan(5000);
    expect(isQueuedReadingReadyForSync({ ...record, status: "conflict" }, 10000)).toBe(false);
    expect(isQueuedReadingReadyForSync({ ...record, attempts: 5 }, 10000)).toBe(false);
    expect(computeReadingRetryDelay(10, 0.5)).toBe(300000);
  });
});
