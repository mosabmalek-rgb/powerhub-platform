import { describe, expect, it } from "vitest";
import { OfflineSyncMetadataError, type SyncMetadataRecord } from "./offline-sync-metadata";

const aliceSite7: SyncMetadataRecord = {
  operationId: "op-a",
  userId: 1,
  tenantId: 10,
  siteId: 7,
  kind: "subscriber_create",
  dependsOn: [],
  attempts: 0,
  nextAttemptAt: 100,
  outcome: "pending",
  updatedAt: 100,
};

function validateRecord(record: SyncMetadataRecord) {
  return record.operationId.length > 0
    && record.userId > 0
    && record.siteId > 0
    && Array.isArray(record.dependsOn)
    && Number.isFinite(record.attempts)
    && record.attempts >= 0
    && ["pending", "syncing", "applied", "already_applied", "conflict", "retryable", "rejected"].includes(record.outcome);
}

describe("offline sync metadata", () => {
  it("defines a valid tenant/user/site scoped operation record", () => {
    expect(validateRecord(aliceSite7)).toBe(true);
    expect(aliceSite7).toMatchObject({ operationId: "op-a", userId: 1, tenantId: 10, siteId: 7, outcome: "pending" });
  });

  it("keeps dependency and retry fields explicit", () => {
    const record: SyncMetadataRecord = { ...aliceSite7, dependsOn: ["op-parent"], attempts: 3, nextAttemptAt: 500, outcome: "retryable", lastError: "timeout" };
    expect(record.dependsOn).toEqual(["op-parent"]);
    expect(record.attempts).toBe(3);
    expect(record.nextAttemptAt).toBe(500);
    expect(record.outcome).toBe("retryable");
    expect(record.lastError).toBe("timeout");
  });

  it("supports terminal outcomes without retry timestamps", () => {
    const record: SyncMetadataRecord = { ...aliceSite7, attempts: 3, nextAttemptAt: Number.POSITIVE_INFINITY, outcome: "applied", lastError: undefined };
    expect(record.outcome).toBe("applied");
    expect(record.nextAttemptAt).toBe(Number.POSITIVE_INFINITY);
    expect(record.lastError).toBeUndefined();
  });

  it("exposes a dedicated metadata error type", () => {
    const error = new OfflineSyncMetadataError("offline metadata unavailable");
    expect(error).toBeInstanceOf(Error);
  });
});
