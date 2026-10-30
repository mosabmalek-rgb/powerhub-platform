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
const payrollPage = readFileSync(
  resolve(process.cwd(), "client/src/pages/PayrollPage.tsx"),
  "utf8",
);
const employeeAdvancesPage = readFileSync(
  resolve(process.cwd(), "client/src/pages/EmployeeAdvancesPage.tsx"),
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
    expect(syncPanel).toContain("executeReadyOperations({\n          items: syncItems, metadataByOperationId, completedIds, transport, now: Date.now(),\n          isCurrent: () => isSyncRunCurrent(assertCurrent),");
    expect(syncPanel).toContain("const syncItems = pendingItems.filter((item) => metadataByOperationId.has(item.clientOperationId))");
    expect(syncPanel).toContain("حالة المزامنة المحلية مفقودة أو لا تطابق نطاق المسودة؛ أُوقفت إعادة الإرسال تلقائيًا");
    expect(syncPanel).toContain("isSyncMetadataCompatibleWithWorkItem(item, storedRecord)");
    expect(offlineReadingQueue).toContain("isSyncMetadataCompatibleWithWorkItem(item, state)");
    expect(meterReadingsPage).toContain("withOfflineSyncLock({ userId: user.id, siteId }");
    expect(meterReadingsPage).toContain("syncQueuedReadingsUnlocked(records, allowUncertainRecovery)");
    expect(meterReadingsPage).toContain("syncQueuedReadings(records, false)");
  });

  it("preserves server replay outcomes for every shared Outbox transport", () => {
    expect(syncPanel).toContain("return { outcome: result.replayed ? \"already_applied\" : \"applied\" };");
    expect(syncPanel).toContain("approvePaymentDocumentation.mutateAsync");
    expect(syncPanel).toContain("createPayment.mutateAsync");
    expect(syncPanel).toContain("issueInvoice.mutateAsync");
    expect(syncPanel).toContain("syncGeneratorCreate");
    expect(syncPanel).toContain("syncGeneratorUpdate");
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
    expect(retryBody).toContain("for (const item of allItems.filter((entry) => entry.status === \"failed\" || entry.status === \"pending\"))");
    expect(retryBody).toContain("await requeueOfflineWorkForManualRetry({");
    expect(retryBody).not.toContain("upsertSyncMetadata(");
    expect(retryBody).not.toContain("updateOfflineWork(item.id, { status: \"pending\"");
    expect(retryBody).toContain("await syncPendingUnlocked(assertCurrent)");
    expect(retryBody).not.toContain("await syncPending();");
    expect(syncPanel).toContain("const syncPendingUnlocked = async (assertCurrent: () => void) => {");
  });

  it("binds Outbox replay to the original user, branch and generation before each server mutation", () => {
    expect(syncPanel).toContain('const auth = useAuth();');
    expect(syncPanel).toContain("const rawAuthUserId = Number(auth.user?.id);");
    expect(syncPanel).toContain("Number.isSafeInteger(rawAuthUserId) && rawAuthUserId > 0 ? rawAuthUserId : null");
    expect(syncPanel).toContain("const syncIdentityRef = useRef<OfflineSyncRunIdentity | null>(null);");
    expect(syncPanel).toContain("advanceOfflineSyncRunIdentity(syncIdentityRef.current, identitySnapshot)");
    expect(syncPanel).toContain("assertOfflineSyncRunCurrent(owner, syncIdentityRef.current!, requireOnlineAuth)");
    expect(syncPanel).toContain("const operationRunGuards = useRef(new Map<string, () => void>());");
    expect(syncPanel).toContain("isCurrent: () => isSyncRunCurrent(assertCurrent)");
    const runIdentity = readFileSync(resolve(process.cwd(), "client/src/lib/offline-sync-run-identity.ts"), "utf8");
    expect(runIdentity).toContain("current.siteId === owner.siteId");
    expect(runIdentity).toContain("current.authUserId === owner.userId");
    expect(runIdentity).toContain("current.isLoggingOut");
    expect(runIdentity).toContain("current.generation === owner.generation");
    expect(syncPanel).toContain("const runMutation = async <T,>(request: () => Promise<T>): Promise<T> => {");
    expect(syncPanel).toContain("assertCurrentOperation();");
    for (const mutation of [
      "createSubscriber.mutateAsync",
      "updateSubscriber.mutateAsync",
      "createReading.mutateAsync",
      "issueInvoice.mutateAsync",
      "createExpense.mutateAsync",
      "createPayment.mutateAsync",
      "approvePaymentDocumentation.mutateAsync",
      "replayHrOffline.mutateAsync",
      "issueEmployeeAdvance.mutateAsync",
      "repayEmployeeAdvance.mutateAsync",
      "recordFuelFill.mutateAsync",
      "submitPaymentDocumentation.mutateAsync",
    ]) {
      expect(syncPanel).toContain("runMutation(() => " + mutation);
    }
    expect(syncPanel).toContain("runMutation(() => syncGeneratorCreate(");
    expect(syncPanel).toContain("runMutation(() => syncGeneratorUpdate(");
    expect(syncPanel).toContain("assertCurrent();\n      const storedAfter = await listSyncMetadata");
    expect(syncPanel).toContain("if (isSyncRunCurrent(assertCurrent)) toast.error(getErrorMessage(error));");
  });

  it("labels non-Delta HR financial snapshots and requires fresh server reads before financial actions", () => {
    expect(payrollPage).toContain("offlineRuns.dataUpdatedAt");
    expect(payrollPage).toContain("isShowingCachedPayrollRuns");
    expect(payrollPage).toContain("hasLivePayrollRuns");
    expect(payrollPage).toContain("disabled={!hasLivePayrollRuns || run.pendingOffline}");
    expect(payrollPage).toContain("هذه اللقطة ليست حالة حية ولا تغذية Delta");

    expect(employeeAdvancesPage).toContain("offlineAdvances.dataUpdatedAt");
    expect(employeeAdvancesPage).toContain("isShowingCachedAdvances");
    expect(employeeAdvancesPage).toContain("canMutateAdvances");
    expect(employeeAdvancesPage).toContain("تعذر التحقق من أحدث رصيد للسلفة وحساب الشركة");
    expect(employeeAdvancesPage).toContain("هذه اللقطة ليست Delta ولا تمثل رصيدًا نهائيًا");
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
    expect(offlineWorkQueue).toContain('database.transaction([storeName, syncMetadataStoreName], "readwrite")');
    expect(offlineWorkQueue).toContain("metadataStore.add(createInitialSyncMetadataRecord(record, dependsOn))");
    expect(offlineWorkQueue).toContain("operationsStore.add(record)");
  });

  it("requeues an eligible failed work row and retry metadata in one IndexedDB transaction", () => {
    expect(offlineWorkQueue).toContain("export async function requeueOfflineWorkForManualRetry");
    expect(offlineWorkQueue).toContain('database.transaction([storeName, syncMetadataStoreName], "readwrite")');
    expect(offlineWorkQueue).toContain("canRequeueOfflineWorkForManualRecovery(operation, metadata)");
    expect(offlineWorkQueue).toContain("isSyncMetadataCompatibleWithWorkItem(item, metadata)");
    expect(offlineWorkQueue).toContain("isManualSyncRecoveryRequired(metadata)");
    expect(offlineWorkQueue).toContain("operations.put({ ...operation, status: \"pending\", error: undefined, updatedAt: now })");
    expect(offlineWorkQueue).toContain("metadataStore.put({");
    expect(syncPanel).toContain("await requeueOfflineWorkForManualRetry({");
    expect(syncPanel).not.toContain("await upsertSyncMetadata({\n            ...baseMetadata");
  });
});
