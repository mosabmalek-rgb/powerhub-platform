import { openLegacyOfflineDatabaseIfPresent, openOfflineWorkspaceDatabase } from "./offline-workspace-db";

export type QueuedReadingStatus = "pending" | "conflict" | "failed";
export type QueuedReadingErrorKind = "retryable" | "conflict" | "terminal";

export type QueuedReading = {
  id: string;
  clientOperationId: string;
  userId: number;
  siteId: number;
  subscriberId: number;
  readingValue: string;
  readingAt: string;
  captureMethod: "manual" | "photo" | "smart_meter";
  imageData?: string;
  imageMime?: "image/jpeg" | "image/png" | "image/webp";
  notes?: string;
  isReadingReset?: boolean;
  overrideSameDay?: boolean;
  fieldVerified?: boolean;
  createdAt: number;
  status: QueuedReadingStatus;
  attempts: number;
  nextAttemptAt: number;
  lastErrorCode?: string;
  lastErrorKind?: QueuedReadingErrorKind;
  error?: string;
};

const legacyDatabaseName = "powerhub-field-queue";
const legacyStoreName = "readings";
const legacyOrphanedStoreName = "orphaned_readings";
const storeName = "fieldReadings";
const orphanedStoreName = "orphanedFieldReadings";
export const READING_SYNC_MAX_ATTEMPTS = 5;
const READING_SYNC_BASE_DELAY_MS = 1_000;
const READING_SYNC_MAX_DELAY_MS = 5 * 60_000;

export class OfflineQueueError extends Error {}

export function assertOfflineQueueAvailable() {
  if (typeof indexedDB === "undefined") throw new OfflineQueueError("لا يدعم هذا المتصفح حفظ العمليات الميدانية دون اتصال.");
}

export function classifyReadingSyncError(errorCode?: string): QueuedReadingErrorKind {
  if (errorCode === "CONFLICT") return "conflict";
  if (["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST", "NOT_FOUND", "VALIDATION_FAILED", "PRECONDITION_FAILED", "PAYLOAD_TOO_LARGE"].includes(errorCode ?? "")) return "terminal";
  return "retryable";
}

export function computeReadingRetryDelay(attempts: number, random = Math.random()) {
  const exponent = Math.max(0, attempts - 1);
  const base = Math.min(READING_SYNC_MAX_DELAY_MS, READING_SYNC_BASE_DELAY_MS * 2 ** exponent);
  const jitter = 0.75 + random * 0.5;
  return Math.min(READING_SYNC_MAX_DELAY_MS, Math.round(base * jitter));
}

export function scheduleReadingRetry(record: QueuedReading, now = Date.now(), random = Math.random()) {
  const attempts = record.attempts + 1;
  return {
    attempts,
    nextAttemptAt: attempts >= READING_SYNC_MAX_ATTEMPTS
      ? Number.POSITIVE_INFINITY
      : now + computeReadingRetryDelay(attempts, random),
  };
}

export function isQueuedReadingReadyForSync(record: QueuedReading, now = Date.now()) {
  if (record.status === "pending") return record.nextAttemptAt <= now;
  return record.status === "failed"
    && record.lastErrorKind === "retryable"
    && record.attempts < READING_SYNC_MAX_ATTEMPTS
    && record.nextAttemptAt <= now;
}

let legacyReadingQueueMigration: Promise<void> | null = null;

async function migrateLegacyReadingQueue(target: IDBDatabase) {
  const legacy = await openLegacyOfflineDatabaseIfPresent(legacyDatabaseName, [legacyStoreName]);
  if (!legacy) return;
  const sourceStores = [
    legacyStoreName,
    ...(legacy.objectStoreNames.contains(legacyOrphanedStoreName) ? [legacyOrphanedStoreName] : []),
  ];
  const source = await new Promise<{
    readings: Array<Record<string, unknown>>;
    orphaned: Array<Record<string, unknown>>;
  }>((resolve, reject) => {
    const tx = legacy.transaction(sourceStores, "readonly");
    const readingsRequest = tx.objectStore(legacyStoreName).getAll();
    const orphanedRequest = sourceStores.includes(legacyOrphanedStoreName)
      ? tx.objectStore(legacyOrphanedStoreName).getAll()
      : null;
    let readings: Array<Record<string, unknown>> = [];
    let orphaned: Array<Record<string, unknown>> = [];
    readingsRequest.onsuccess = () => { readings = readingsRequest.result as Array<Record<string, unknown>>; };
    if (orphanedRequest) orphanedRequest.onsuccess = () => { orphaned = orphanedRequest.result as Array<Record<string, unknown>>; };
    readingsRequest.onerror = () => { try { tx.abort(); } catch {} };
    if (orphanedRequest) orphanedRequest.onerror = () => { try { tx.abort(); } catch {} };
    tx.oncomplete = () => { legacy.close(); resolve({ readings, orphaned }); };
    tx.onerror = () => { legacy.close(); reject(tx.error ?? new Error("تعذر قراءة طابور القراءات القديم.")); };
    tx.onabort = () => { legacy.close(); reject(tx.error ?? new Error("أُلغي ترحيل طابور القراءات القديم.")); };
  });

  const validReadings: Array<Record<string, unknown> & {
    id: string; userId: number; siteId: number; subscriberId: number;
  }> = [];
  const quarantined: Array<Record<string, unknown> & {
    id: string; quarantinedAt: number; quarantineReason: string;
  }> = [];

  for (const raw of source.readings) {
    const { meterId: _meterId, ...normalized } = raw as Record<string, unknown> & { meterId?: unknown };
    void _meterId;
    const id = String(normalized.id ?? crypto.randomUUID());
    const userId = Number(normalized.userId);
    const siteId = Number(normalized.siteId);
    const subscriberId = Number(normalized.subscriberId);
    if (!Number.isSafeInteger(userId) || userId < 1) {
      quarantined.push({ ...normalized, id, quarantinedAt: Date.now(), quarantineReason: "missing-user-scope" });
    } else if (!Number.isSafeInteger(siteId) || siteId < 1) {
      quarantined.push({ ...normalized, id, quarantinedAt: Date.now(), quarantineReason: "missing-site-scope" });
    } else if (!Number.isSafeInteger(subscriberId) || subscriberId < 1) {
      quarantined.push({ ...normalized, id, quarantinedAt: Date.now(), quarantineReason: "missing-subscriber-scope" });
    } else {
      validReadings.push({
        ...normalized,
        id,
        userId,
        siteId,
        subscriberId,
        attempts: Number.isFinite(Number(normalized.attempts)) ? Number(normalized.attempts) : 0,
        nextAttemptAt: Number.isFinite(Number(normalized.nextAttemptAt))
          ? Number(normalized.nextAttemptAt)
          : Number(normalized.createdAt ?? Date.now()),
      });
    }
  }

  for (const raw of source.orphaned) {
    quarantined.push({
      ...raw,
      id: String(raw.id ?? crypto.randomUUID()),
      quarantinedAt: Number(raw.quarantinedAt ?? Date.now()),
      quarantineReason: String(raw.quarantineReason ?? "previously-quarantined"),
    });
  }

  await new Promise<void>((resolve, reject) => {
    const tx = target.transaction([storeName, orphanedStoreName], "readwrite");
    const readingsStore = tx.objectStore(storeName);
    const orphanedStore = tx.objectStore(orphanedStoreName);
    const readingsKeysRequest = readingsStore.getAllKeys();
    const orphanedKeysRequest = orphanedStore.getAllKeys();
    let readingsKeys = new Set<IDBValidKey>();
    let orphanedKeys = new Set<IDBValidKey>();
    let readingsReady = false;
    let orphanedReady = false;
    let copied = false;
    const merge = () => {
      if (copied || !readingsReady || !orphanedReady) return;
      copied = true;
      for (const record of validReadings) {
        if (!readingsKeys.has(record.id)) readingsStore.put(record);
      }
      for (const record of quarantined) {
        if (!orphanedKeys.has(record.id)) orphanedStore.put(record);
      }
    };
    readingsKeysRequest.onsuccess = () => { readingsKeys = new Set(readingsKeysRequest.result); readingsReady = true; merge(); };
    orphanedKeysRequest.onsuccess = () => { orphanedKeys = new Set(orphanedKeysRequest.result); orphanedReady = true; merge(); };
    readingsKeysRequest.onerror = () => { try { tx.abort(); } catch {} };
    orphanedKeysRequest.onerror = () => { try { tx.abort(); } catch {} };
    tx.oncomplete = () => {
      resolve();
      const removal = indexedDB.deleteDatabase(legacyDatabaseName);
      removal.onerror = () => undefined;
      removal.onblocked = () => undefined;
    };
    tx.onerror = () => reject(tx.error ?? new Error("تعذر حفظ القراءات المرحّلة."));
    tx.onabort = () => reject(tx.error ?? new Error("أُلغي حفظ القراءات المرحّلة."));
  });
}

async function openQueueDatabase() {
  assertOfflineQueueAvailable();
  const db = await openOfflineWorkspaceDatabase();
  if (!legacyReadingQueueMigration) {
    legacyReadingQueueMigration = migrateLegacyReadingQueue(db).catch((error) => {
      legacyReadingQueueMigration = null;
      db.close();
      console.warn("[PowerHub] Legacy field reading queue migration deferred; source data preserved.", error);
      throw error;
    });
  }
  await legacyReadingQueueMigration;
  return db;
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openQueueDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر تحديث طابور القراءات."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("تعذر حفظ عملية الميدان.")); };
  });
}

export async function listQueuedReadings(options: { userId: number; siteId?: number }) {
  const records = await transact<QueuedReading[]>("readonly", (store) => store.getAll());
  return records.filter((record) => record.userId === options.userId && (options.siteId === undefined || record.siteId === options.siteId)).sort((a, b) => a.createdAt - b.createdAt);
}

export async function enqueueReading(reading: Omit<QueuedReading, "id" | "createdAt" | "status" | "attempts" | "nextAttemptAt">) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const record: QueuedReading = { ...reading, id, clientOperationId: reading.clientOperationId || id, createdAt: now, status: "pending", attempts: 0, nextAttemptAt: now };
  await transact("readwrite", (store) => store.put(record));
  return record;
}

export async function updateQueuedReading(
  id: string,
  patch: Partial<Pick<QueuedReading, "status" | "error" | "attempts" | "nextAttemptAt" | "lastErrorCode" | "lastErrorKind">>,
) {
  const existing = await transact<QueuedReading | undefined>("readonly", (store) => store.get(id));
  if (!existing) return;
  await transact("readwrite", (store) => store.put({ ...existing, ...patch }));
}

export async function removeQueuedReading(id: string) {
  await transact("readwrite", (store) => store.delete(id));
}
