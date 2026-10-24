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
    expect(syncPanel).toContain("حالة المزامنة المحلية مفقودة؛ أُوقفت إعادة الإرسال تلقائيًا");
    expect(meterReadingsPage).toContain("withOfflineSyncLock({ userId: user.id, siteId }");
    expect(meterReadingsPage).toContain("syncQueuedReadingsUnlocked(records)");
  });

  it("does not overwrite atomically persisted reading metadata with a stale pending result", () => {
    expect(offlineReadingQueue).not.toContain("await upsertSyncMetadata(syncRecord)");
    expect(offlineReadingQueue).toContain("getSyncMetadata(item.clientOperationId");
    expect(offlineReadingQueue).toContain("getSyncMetadata(queued.item.clientOperationId");
    expect(offlineReadingQueue).toContain("enqueueOfflineWork({");
    expect(offlineReadingQueue).toContain("enqueueOfflineReadingWithInvoiceNumber");
    expect(offlineReadingQueue).toContain('state?.outcome === "applied" || state?.outcome === "already_applied"');
    expect(offlineReadingQueue).toContain("await removeOfflineConflict(item.userId, item.clientOperationId)");
    expect(offlineWorkQueue).toContain("transaction.objectStore(storeName).add(record)");
    expect(offlineWorkQueue).toContain("transaction.objectStore(syncMetadataStoreName).add(createInitialSyncMetadataRecord(record))");
  });
});
