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

const databaseName = "powerhub-field-queue";
const storeName = "readings";
const orphanedStoreName = "orphaned_readings";
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

function openQueueDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    assertOfflineQueueAvailable();
    const request = indexedDB.open(databaseName, 3);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction!;
      const store = database.objectStoreNames.contains(storeName)
        ? transaction.objectStore(storeName)
        : database.createObjectStore(storeName, { keyPath: "id" });

      if ((event as IDBVersionChangeEvent).oldVersion < 2) {
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const legacy = cursor.value as Partial<QueuedReading> & { meterId?: number };
          if (!legacy.subscriberId) cursor.delete();
          else {
            const { meterId: _meterId, ...subscriberReading } = legacy;
            void _meterId;
            cursor.update(subscriberReading);
          }
          cursor.continue();
        };
      }

      if ((event as IDBVersionChangeEvent).oldVersion < 3) {
        const orphaned = database.objectStoreNames.contains(orphanedStoreName)
          ? transaction.objectStore(orphanedStoreName)
          : database.createObjectStore(orphanedStoreName, { keyPath: "id" });
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const legacy = cursor.value as Partial<QueuedReading>;
          if (!legacy.userId) {
            orphaned.put({ ...legacy, quarantinedAt: Date.now(), quarantineReason: "missing-user-scope" });
            cursor.delete();
          } else {
            cursor.update({ ...legacy, attempts: Number(legacy.attempts ?? 0), nextAttemptAt: Number(legacy.nextAttemptAt ?? Date.now()) });
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح طابور العمل دون اتصال."));
  });
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
