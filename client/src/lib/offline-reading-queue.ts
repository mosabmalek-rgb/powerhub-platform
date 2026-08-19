export type QueuedReadingStatus = "pending" | "conflict" | "failed";

export type QueuedReading = {
  id: string;
  clientOperationId: string;
  siteId: number;
  meterId: number;
  readingValue: string;
  captureMethod: "manual" | "photo" | "smart_meter";
  imageData?: string;
  imageMime?: "image/jpeg" | "image/png" | "image/webp";
  notes?: string;
  createdAt: number;
  status: QueuedReadingStatus;
  error?: string;
};

const databaseName = "powerhub-field-queue";
const storeName = "readings";

export class OfflineQueueError extends Error {}

export function assertOfflineQueueAvailable() {
  if (typeof indexedDB === "undefined") throw new OfflineQueueError("لا يدعم هذا المتصفح حفظ العمليات الميدانية دون اتصال.");
}

function openQueueDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    assertOfflineQueueAvailable();
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: "id" });
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

export async function listQueuedReadings(siteId?: number) {
  const records = await transact<QueuedReading[]>("readonly", (store) => store.getAll());
  return records.filter((record) => siteId === undefined || record.siteId === siteId).sort((a, b) => a.createdAt - b.createdAt);
}

export async function enqueueReading(reading: Omit<QueuedReading, "id" | "createdAt" | "status">) {
  const id = crypto.randomUUID();
  const record: QueuedReading = { ...reading, id, clientOperationId: reading.clientOperationId || id, createdAt: Date.now(), status: "pending" };
  await transact("readwrite", (store) => store.put(record));
  return record;
}

export async function updateQueuedReading(id: string, patch: Partial<Pick<QueuedReading, "status" | "error">>) {
  const existing = await transact<QueuedReading | undefined>("readonly", (store) => store.get(id));
  if (!existing) return;
  await transact("readwrite", (store) => store.put({ ...existing, ...patch }));
}

export async function removeQueuedReading(id: string) {
  await transact("readwrite", (store) => store.delete(id));
}
