import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const meterReadingsPage = readFileSync(
  resolve(process.cwd(), "client/src/pages/MeterReadingsPage.tsx"),
  "utf8",
);
const syncPanel = readFileSync(
  resolve(process.cwd(), "client/src/components/OfflineWorkSyncPanel.tsx"),
  "utf8",
);
const offlineReadingQueue = readFileSync(
  resolve(process.cwd(), "client/src/lib/offline-reading-queue.ts"),
  "utf8",
);
const offlineWorkQueue = readFileSync(
  resolve(process.cwd(), "client/src/lib/offline-work-queue.ts"),
  "utf8",
);

describe("offline sync UI contract", () => {
  it("refreshes the field-reading outbox view after the sync result is persisted", () => {
    const syncStart = meterReadingsPage.indexOf("const syncQueuedReadings");
    const syncEnd = meterReadingsPage.indexOf("\n  useEffect(", syncStart);
    expect(syncStart).toBeGreaterThanOrEqual(0);
    expect(syncEnd).toBeGreaterThan(syncStart);
    const syncBody = meterReadingsPage.slice(syncStart, syncEnd);
    const resultPersistence = syncBody.lastIndexOf("await updateOfflineWork(item.id");
    const queueRefresh = syncBody.lastIndexOf("await loadQueuedReadings();");
    expect(resultPersistence).toBeGreaterThanOrEqual(0);
    expect(queueRefresh).toBeGreaterThan(resultPersistence);
  });

  it("routes field reading creates through the shared offline executor", () => {
    expect(meterReadingsPage).toContain("executeReadyOperations({");
    expect(syncPanel).toContain('if (item.kind === "reading_create")');
    expect(syncPanel).toContain("executeReadyOperations({ items: syncItems");
    expect(syncPanel).toContain("const syncItems = pendingItems.filter((item) => metadataByOperationId.has(item.clientOperationId))");
    expect(syncPanel).toContain("حالة المزامنة المحلية مفقودة أو لا تطابق نطاق المسودة؛ أُوقفت إعادة الإرسال تلقائيًا");
    expect(syncPanel).toContain("isSyncMetadataCompatibleWithWorkItem(item, storedRecord)");
    expect(offlineReadingQueue).toContain("isSyncMetadataCompatibleWithWorkItem(item, state)");
    expect(meterReadingsPage).toContain("withOfflineSyncLock({ userId: user.id, siteId }");
    expect(meterReadingsPage).toContain("syncQueuedReadingsUnlocked(records)");
  });

  it("serializes manual retry state changes with the same cross-tab sync lock", () => {
    const retryStart = syncPanel.indexOf("const retryFailedAndSync = async () => {");
    const retryEnd = syncPanel.indexOf("\n  useEffect(", retryStart);
    expect(retryStart).toBeGreaterThanOrEqual(0);
    expect(retryEnd).toBeGreaterThan(retryStart);
    const retryBody = syncPanel.slice(retryStart, retryEnd);
    const lockIndex = retryBody.indexOf("withOfflineSyncLock({ userId, siteId }");
    const readIndex = retryBody.indexOf("listOfflineWork({ userId, siteId })");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(readIndex);
    expect(retryBody).toContain("await requeueOfflineWorkForManualRetry({");
    expect(retryBody).not.toContain("upsertSyncMetadata(");
    expect(retryBody).not.toContain("updateOfflineWork(item.id, { status: \"pending\"");
    expect(retryBody).toContain("await syncPendingUnlocked()");
    expect(retryBody).not.toContain("await syncPending();");
    expect(syncPanel).toContain("const syncPendingUnlocked = async () => {");
  });

  it("does not overwrite atomically persisted reading metadata with a stale pending result", () => {
    expect(offlineReadingQueue).not.toContain("await upsertSyncMetadata(syncRecord)");
    expect(offlineReadingQueue).toContain("getSyncMetadata(item.clientOperationId");
    expect(offlineReadingQueue).toContain("getSyncMetadata(queued.item.clientOperationId");
    expect(offlineReadingQueue).toContain("enqueueOfflineWork({");
    expect(offlineReadingQueue).toContain("enqueueOfflineReadingWithInvoiceNumber");
    expect(offlineReadingQueue).toContain("if (!isSyncMetadataCompatibleWithWorkItem(item, state))");
    expect(offlineReadingQueue).toContain('if (state.outcome === "applied" || state.outcome === "already_applied")');
    expect(offlineReadingQueue).toContain("await removeOfflineConflict(item.userId, item.clientOperationId)");
    expect(offlineWorkQueue).toContain("transaction.objectStore(storeName).add(record)");
    expect(offlineWorkQueue).toContain("transaction.objectStore(syncMetadataStoreName).add(createInitialSyncMetadataRecord(record))");
  });

  it("requeues an eligible failed work row and retry metadata in one IndexedDB transaction", () => {
    expect(offlineWorkQueue).toContain("export async function requeueOfflineWorkForManualRetry");
    expect(offlineWorkQueue).toContain('database.transaction([storeName, syncMetadataStoreName], "readwrite")');
    expect(offlineWorkQueue).toContain("canRequeueFailedOfflineWork(operation, metadata)");
    expect(offlineWorkQueue).toContain("operations.put({ ...operation, status: \"pending\", error: undefined, updatedAt: now })");
    expect(offlineWorkQueue).toContain("metadataStore.put({");
    expect(syncPanel).toContain("await requeueOfflineWorkForManualRetry({");
    expect(syncPanel).not.toContain("await upsertSyncMetadata({\n            ...baseMetadata");
  });
});
