import {
  enqueueOfflineWork, getOfflineWork, listOfflineWork, removeOfflineWork, updateOfflineWork,
  type QueuedOfflineWork, type ReadingCreateDraft,
} from "./offline-work-queue";
import {
  getSyncMetadata, listSyncMetadata, removeSyncMetadata, upsertSyncMetadata,
  type SyncMetadataRecord,
} from "./offline-sync-metadata";
import { classifySyncResult, computeBackoffDelay, scheduleRetry, SYNC_MAX_ATTEMPTS } from "./offline-sync-engine";
import { removeOfflineConflict, upsertOfflineConflict } from "./offline-workspace-db";

export type QueuedReadingStatus = "pending" | "conflict" | "failed";
export type QueuedReadingErrorKind = "retryable" | "conflict" | "terminal";
export type QueuedReading = ReadingCreateDraft & {
  id: string; clientOperationId: string; userId: number; tenantId?: number; siteId: number;
  createdAt: number; status: QueuedReadingStatus; attempts: number; nextAttemptAt: number;
  lastErrorCode?: string; lastErrorKind?: QueuedReadingErrorKind; error?: string;
};
type NewQueuedReading = Omit<QueuedReading,
  "id" | "createdAt" | "status" | "attempts" | "nextAttemptAt" | "lastErrorCode" | "lastErrorKind" | "error">;

export const READING_SYNC_MAX_ATTEMPTS = SYNC_MAX_ATTEMPTS;
export class OfflineQueueError extends Error {}
export function assertOfflineQueueAvailable() {
  if (typeof indexedDB === "undefined") throw new OfflineQueueError("لا يدعم هذا المتصفح حفظ العمليات الميدانية دون اتصال.");
}
export function classifyReadingSyncError(errorCode?: string): QueuedReadingErrorKind {
  const outcome = errorCode ? classifySyncResult(errorCode) : "retryable";
  if (outcome === "conflict") return "conflict";
  if (outcome === "rejected") return "terminal";
  return "retryable";
}
export function computeReadingRetryDelay(attempts: number, random = Math.random()) {
  return computeBackoffDelay(attempts, random);
}
export function scheduleReadingRetry(record: QueuedReading, now = Date.now(), random = Math.random()) {
  const retry = scheduleRetry({
    operationId: record.clientOperationId, dependsOn: [],
    attempts: record.attempts, nextAttemptAt: record.nextAttemptAt,
  }, now, random);
  return { attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt };
}
export function isQueuedReadingReadyForSync(record: QueuedReading, now = Date.now()) {
  if (record.status === "pending") return record.nextAttemptAt <= now;
  return record.status === "failed" && record.lastErrorKind === "retryable" &&
    record.attempts < READING_SYNC_MAX_ATTEMPTS && record.nextAttemptAt <= now;
}
function isReadingWork(item: QueuedOfflineWork): item is QueuedOfflineWork & { kind: "reading_create"; payload: ReadingCreateDraft } {
  return item.kind === "reading_create";
}
function mapWorkToReading(item: QueuedOfflineWork, metadata?: SyncMetadataRecord): QueuedReading {
  const raw = item.payload as ReadingCreateDraft;
  const status: QueuedReadingStatus = item.status === "conflict" || metadata?.outcome === "conflict" ? "conflict"
    : item.status === "failed" || metadata?.outcome === "retryable" || metadata?.outcome === "rejected" ? "failed" : "pending";
  const lastErrorKind: QueuedReadingErrorKind | undefined = status === "conflict" ? "conflict"
    : metadata?.outcome === "retryable" ? "retryable"
    : metadata?.outcome === "rejected" ? "terminal"
    : item.status === "failed" ? "terminal" : undefined;
  return {
    subscriberId: Number(raw.subscriberId),
    readingValue: String(raw.readingValue ?? ""),
    readingAt: typeof raw.readingAt === "string" ? raw.readingAt : new Date(String(raw.readingAt)).toISOString(),
    captureMethod: raw.captureMethod === "photo" || raw.captureMethod === "smart_meter" ? raw.captureMethod : "manual",
    ...(raw.imageData !== undefined ? { imageData: raw.imageData } : {}),
    ...(raw.imageMime !== undefined ? { imageMime: raw.imageMime } : {}),
    ...(raw.notes !== undefined ? { notes: raw.notes } : {}),
    ...(raw.isReadingReset !== undefined ? { isReadingReset: raw.isReadingReset } : {}),
    ...(raw.overrideSameDay !== undefined ? { overrideSameDay: raw.overrideSameDay } : {}),
    ...(raw.fieldVerified !== undefined ? { fieldVerified: raw.fieldVerified } : {}),
    id: item.id, clientOperationId: item.clientOperationId, userId: item.userId,
    ...(item.tenantId !== undefined ? { tenantId: item.tenantId } : {}),
    siteId: item.siteId, createdAt: item.createdAt, status,
    attempts: metadata?.attempts ?? 0, nextAttemptAt: metadata?.nextAttemptAt ?? item.createdAt,
    ...(metadata?.lastErrorCode ? { lastErrorCode: metadata.lastErrorCode } : {}),
    ...(lastErrorKind ? { lastErrorKind } : {}),
    ...((metadata?.lastError ?? item.error) ? { error: metadata?.lastError ?? item.error } : {}),
  };
}
/** Field readings are an adapter over the canonical operations Outbox. */
export async function listQueuedReadings(options: { userId: number; siteId?: number }) {
  const items = await listOfflineWork(options); // Runs the one-time legacy migration first.
  const metadata = await listSyncMetadata(options);
  const byOperation = new Map(metadata.map((row) => [row.operationId, row]));
  return items.filter((item) => isReadingWork(item) && item.status !== "applied")
    .map((item) => mapWorkToReading(item, byOperation.get(item.clientOperationId)))
    .sort((a, b) => a.createdAt - b.createdAt);
}
export async function enqueueReading(reading: NewQueuedReading) {
  assertOfflineQueueAvailable();
  const existing = await getOfflineWork(reading.clientOperationId);
  if (existing) {
    if (existing.kind !== "reading_create" || existing.userId !== reading.userId ||
        existing.siteId !== reading.siteId || existing.clientOperationId !== reading.clientOperationId) {
      throw new OfflineQueueError("معرف عملية القراءة مستخدم في نطاق مختلف؛ لم يتم استبدال المسودة.");
    }
    const priorMetadata = await getSyncMetadata(existing.clientOperationId, { userId: existing.userId, siteId: existing.siteId });
    return mapWorkToReading(existing, priorMetadata);
  }
  const sameUser = await listOfflineWork({ userId: reading.userId });
  const duplicate = sameUser.find((item) => item.clientOperationId === reading.clientOperationId);
  if (duplicate) {
    if (duplicate.kind !== "reading_create" || duplicate.siteId !== reading.siteId) {
      throw new OfflineQueueError("معرف عملية القراءة مستخدم في نطاق مختلف؛ لم يتم استبدال المسودة.");
    }
    const priorMetadata = await getSyncMetadata(duplicate.clientOperationId, { userId: duplicate.userId, siteId: duplicate.siteId });
    return mapWorkToReading(duplicate, priorMetadata);
  }
  const payload: ReadingCreateDraft = {
    subscriberId: reading.subscriberId, readingValue: reading.readingValue,
    readingAt: reading.readingAt, captureMethod: reading.captureMethod,
    ...(reading.imageData !== undefined ? { imageData: reading.imageData } : {}),
    ...(reading.imageMime !== undefined ? { imageMime: reading.imageMime } : {}),
    ...(reading.notes !== undefined ? { notes: reading.notes } : {}),
    ...(reading.isReadingReset !== undefined ? { isReadingReset: reading.isReadingReset } : {}),
    ...(reading.overrideSameDay !== undefined ? { overrideSameDay: reading.overrideSameDay } : {}),
    ...(reading.fieldVerified !== undefined ? { fieldVerified: reading.fieldVerified } : {}),
  };
  const item = await enqueueOfflineWork({
    userId: reading.userId, ...(reading.tenantId !== undefined ? { tenantId: reading.tenantId } : {}),
    siteId: reading.siteId, kind: "reading_create", payload,
    clientOperationId: reading.clientOperationId,
  });
  const now = Date.now();
  const syncRecord: SyncMetadataRecord = {
    operationId: item.clientOperationId, userId: item.userId,
    ...(item.tenantId !== undefined ? { tenantId: item.tenantId } : {}),
    siteId: item.siteId, kind: item.kind, dependsOn: [], attempts: 0,
    nextAttemptAt: now, outcome: "pending", updatedAt: now,
  };
  await upsertSyncMetadata(syncRecord);
  return mapWorkToReading(item, syncRecord);
}
export async function updateQueuedReading(
  id: string,
  patch: Partial<Pick<QueuedReading, "status" | "error" | "attempts" | "nextAttemptAt" | "lastErrorCode" | "lastErrorKind">>,
) {
  const item = await getOfflineWork(id);
  if (!item || !isReadingWork(item) || item.status === "applied") return;
  const existing = await getSyncMetadata(item.clientOperationId, { userId: item.userId, siteId: item.siteId });
  const status = patch.status ?? item.status;
  const hasErrorPatch = Object.prototype.hasOwnProperty.call(patch, "error");
  const error = hasErrorPatch ? patch.error : existing?.lastError ?? item.error;
  const attempts = patch.attempts ?? existing?.attempts ?? 0;
  const kind = patch.lastErrorKind ?? (existing?.outcome === "conflict" ? "conflict"
    : existing?.outcome === "retryable" ? "retryable"
    : existing?.outcome === "rejected" ? "terminal" : undefined);
  const outcome: SyncMetadataRecord["outcome"] = status === "conflict" ? "conflict"
    : status === "failed" ? (kind === "retryable" ? "retryable" : "rejected") : "pending";
  const nextAttemptAt = patch.nextAttemptAt ??
    (status === "conflict" || outcome === "rejected" ? Number.POSITIVE_INFINITY : existing?.nextAttemptAt ?? item.createdAt);
  const lastErrorCode = patch.lastErrorCode ?? existing?.lastErrorCode;
  await updateOfflineWork(id, { status, ...(hasErrorPatch ? { error: patch.error } : {}) });
  await upsertSyncMetadata({
    operationId: item.clientOperationId, userId: item.userId,
    ...(item.tenantId !== undefined ? { tenantId: item.tenantId } : {}),
    siteId: item.siteId, kind: item.kind, dependsOn: existing?.dependsOn ?? [],
    attempts, nextAttemptAt, outcome,
    ...(error ? { lastError: error } : {}),
    ...(lastErrorCode ? { lastErrorCode } : {}), updatedAt: Date.now(),
  });
  if (status === "conflict") {
    await upsertOfflineConflict({
      userId: item.userId, ...(item.tenantId !== undefined ? { tenantId: item.tenantId } : {}),
      siteId: item.siteId, operationId: item.clientOperationId, kind: item.kind,
      outcome: "conflict", message: error ?? "تعارض قراءة يحتاج إلى مراجعة.",
      createdAt: item.createdAt, updatedAt: Date.now(), localPayload: item.payload,
    });
  } else await removeOfflineConflict(item.userId, item.clientOperationId);
}
export async function removeQueuedReading(id: string) {
  const item = await getOfflineWork(id);
  if (!item || !isReadingWork(item)) return;
  await removeOfflineWork(id);
  await removeSyncMetadata(item.clientOperationId, { userId: item.userId, siteId: item.siteId });
  await removeOfflineConflict(item.userId, item.clientOperationId);
}
