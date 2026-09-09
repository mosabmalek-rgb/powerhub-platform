import { beforeEach, describe, expect, it } from "vitest";
import { getSyncMetadata, listSyncMetadata, removeSyncMetadata, upsertSyncMetadata, type SyncMetadataRecord } from "./offline-sync-metadata";

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

const bobSite7: SyncMetadataRecord = {
  ...aliceSite7,
  operationId: "op-b",
  userId: 2,
  updatedAt: 110,
};

const aliceSite8: SyncMetadataRecord = {
  ...aliceSite7,
  operationId: "op-c",
  siteId: 8,
  updatedAt: 120,
};

describe("offline sync metadata", () => {
  beforeEach(() => {
    indexedDB.deleteDatabase("powerhub-offline-sync");
  });

  it("round-trips one operation", async () => {
    await upsertSyncMetadata(aliceSite7);
    expect(await getSyncMetadata("op-a")).toEqual(aliceSite7);
  });

  it("scopes listing by user and optional site", async () => {
    await Promise.all([upsertSyncMetadata(aliceSite7), upsertSyncMetadata(bobSite7), upsertSyncMetadata(aliceSite8)]);
    expect((await listSyncMetadata({ userId: 1 })).map((row) => row.operationId)).toEqual(["op-c", "op-a"]);
    expect((await listSyncMetadata({ userId: 1, siteId: 7 })).map((row) => row.operationId)).toEqual(["op-a"]);
    expect((await listSyncMetadata({ userId: 2 })).map((row) => row.operationId)).toEqual(["op-b"]);
  });

  it("persists retry state and terminal outcomes", async () => {
    await upsertSyncMetadata({ ...aliceSite7, attempts: 3, nextAttemptAt: 500, outcome: "retryable", lastError: "timeout" });
    expect(await getSyncMetadata("op-a")).toMatchObject({ attempts: 3, nextAttemptAt: 500, outcome: "retryable", lastError: "timeout" });
    await upsertSyncMetadata({ ...aliceSite7, attempts: 3, nextAttemptAt: Number.POSITIVE_INFINITY, outcome: "applied", lastError: undefined });
    expect(await getSyncMetadata("op-a")).toMatchObject({ attempts: 3, outcome: "applied" });
  });

  it("removes only the requested operation", async () => {
    await Promise.all([upsertSyncMetadata(aliceSite7), upsertSyncMetadata(aliceSite8)]);
    await removeSyncMetadata("op-a");
    expect(await getSyncMetadata("op-a")).toBeUndefined();
    expect(await getSyncMetadata("op-c")).toEqual(aliceSite8);
  });
});
