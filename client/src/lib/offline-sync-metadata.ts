export type SyncMetadataRecord = {
  operationId: string;
  userId: number;
  tenantId?: number;
  siteId: number;
  kind: string;
  dependsOn: string[];
  attempts: number;
  nextAttemptAt: number;
  outcome: "pending" | "syncing" | "applied" | "already_applied" | "conflict" | "retryable" | "rejected";
  lastError?: string;
  updatedAt: number;
};

const databaseName = "powerhub-offline-sync";
const storeName = "metadata";

export class OfflineSyncMetadataError extends Error {}

function assertAvailable() {
  if (typeof indexedDB === "undefined") {
    throw new OfflineSyncMetadataError("لا يدعم هذا المتصفح حفظ حالة المزامنة محلياً.");
  }
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    assertAvailable();
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        const store = request.result.createObjectStore(storeName, { keyPath: "operationId" });
        store.createIndex("userId", "userId", { unique: false });
        store.createIndex("siteId", "siteId", { unique: false });
        store.createIndex("outcome", "outcome", { unique: false });
        store.createIndex("nextAttemptAt", "nextAttemptAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new OfflineSyncMetadataError("تعذر فتح مخزن حالة المزامنة."));
  });
}

export async function upsertSyncMetadata(record: SyncMetadataRecord) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { const error = tx.error; db.close(); reject(error ?? new OfflineSyncMetadataError("تعذر حفظ حالة المزامنة.")); };
    tx.onabort = () => { const error = tx.error; db.close(); reject(error ?? new OfflineSyncMetadataError("تم إلغاء تحديث حالة المزامنة.")); };
  });
}

export async function getSyncMetadata(operationId: string, scope: { userId: number; siteId: number }) {
  const db = await openDatabase();
  return new Promise<SyncMetadataRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(operationId);
    request.onsuccess = () => {
      const record = request.result as SyncMetadataRecord | undefined;
      resolve(record && record.userId === scope.userId && record.siteId === scope.siteId ? record : undefined);
    };
    request.onerror = () => reject(request.error ?? new OfflineSyncMetadataError("تعذر قراءة حالة المزامنة."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { const error = tx.error; db.close(); reject(error ?? new OfflineSyncMetadataError("تعذر قراءة حالة المزامنة.")); };
  });
}

export async function listSyncMetadata(options: { userId: number; siteId?: number }) {
  const db = await openDatabase();
  return new Promise<SyncMetadataRecord[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => {
      const rows = (request.result as SyncMetadataRecord[]).filter(
        (row) => row.userId === options.userId && (options.siteId === undefined || row.siteId === options.siteId),
      );
      resolve(rows.sort((a, b) => b.updatedAt - a.updatedAt));
    };
    request.onerror = () => reject(request.error ?? new OfflineSyncMetadataError("تعذر قراءة حالات المزامنة."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { const error = tx.error; db.close(); reject(error ?? new OfflineSyncMetadataError("تعذر قراءة حالات المزامنة.")); };
  });
}

export async function removeSyncMetadata(operationId: string, scope: { userId: number; siteId: number }) {
  const existing = await getSyncMetadata(operationId, scope);
  if (!existing) return;

  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(operationId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { const error = tx.error; db.close(); reject(error ?? new OfflineSyncMetadataError("تعذر حذف حالة المزامنة.")); };
  });
}
