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
    expect(syncPanel).toContain("executeReadyOperations({ items: pendingItems");
  });
});
