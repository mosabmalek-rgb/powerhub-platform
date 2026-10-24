/**
 * Canonical IndexedDB schema for operational offline work.
 * All writers use the same DB version so the first opener creates every store.
 * Query cache and authentication intentionally remain isolated in their own DBs.
 */
export const OFFLINE_WORKSPACE_DATABASE_NAME = "powerhub-offline-workspace";
export const OFFLINE_WORKSPACE_DATABASE_VERSION = 3;

function ensureStore(
  db: IDBDatabase,
  transaction: IDBTransaction,
  name: string,
  keyPath: string | string[],
  indexes: Array<{ name: string; keyPath: string | string[]; unique?: boolean }> = [],
) {
  const store = db.objectStoreNames.contains(name)
    ? transaction.objectStore(name)
    : db.createObjectStore(name, { keyPath });
  for (const index of indexes) {
    if (!store.indexNames.contains(index.name)) {
      store.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
    }
  }
}

export function openOfflineWorkspaceDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("لا يدعم هذا المتصفح التخزين المحلي لعمليات PowerHub."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_WORKSPACE_DATABASE_NAME, OFFLINE_WORKSPACE_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) {
        request.transaction?.abort();
        return;
      }
      ensureStore(db, tx, "operations", "id");
      ensureStore(db, tx, "grants", "id", [
        { name: "byScope", keyPath: ["userId", "tenantId", "siteId", "deviceId"] },
        { name: "byExpiry", keyPath: "expiresAt" },
      ]);
      ensureStore(db, tx, "claims", "id", [
        { name: "byGrant", keyPath: "grantId" },
        { name: "byGrantNumber", keyPath: ["grantId", "numberValue"], unique: true },
        { name: "byOperation", keyPath: ["userId", "clientOperationId", "entityType"], unique: true },
      ]);
      ensureStore(db, tx, "cursors", ["userId", "tenantId", "siteId", "entityType"]);
      ensureStore(db, tx, "entities", ["scopeKey", "entityId"], [
        { name: "byScope", keyPath: "scopeKey" },
        { name: "byUser", keyPath: "userId" },
      ]);
      ensureStore(db, tx, "syncState", ["userId", "tenantId", "siteId", "entityType"], [
        { name: "byUser", keyPath: "userId" },
        { name: "bySite", keyPath: ["userId", "siteId"] },
        { name: "byOutcome", keyPath: "outcome" },
      ]);
      ensureStore(db, tx, "conflicts", ["userId", "operationId"], [
        { name: "byUser", keyPath: "userId" },
        { name: "bySite", keyPath: ["userId", "siteId"] },
        { name: "byOutcome", keyPath: "outcome" },
      ]);
      ensureStore(db, tx, "syncMetadata", "operationId", [
        { name: "byUser", keyPath: "userId" },
        { name: "bySite", keyPath: ["userId", "siteId"] },
        { name: "byOutcome", keyPath: "outcome" },
        { name: "byNextAttempt", keyPath: "nextAttemptAt" },
      ]);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن PowerHub المحلي."));
    request.onblocked = () => reject(new Error("تعذر ترقية مخزن PowerHub المحلي؛ أغلق تبويبات PowerHub الأخرى ثم أعد المحاولة."));
  });
}

/** Open an optional legacy DB only if it already exists; never retain a probe-created empty DB. */
export async function openLegacyOfflineDatabaseIfPresent(
  databaseName: string,
  requiredStores: readonly string[],
): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  const factory = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
  if (typeof factory.databases === "function") {
    try {
      const databases = await factory.databases();
      if (!databases.some((entry) => entry.name === databaseName)) return null;
    } catch {
      // Fall through for browsers without reliable database enumeration.
    }
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    let createdDuringProbe = false;
    request.onupgradeneeded = () => { createdDuringProbe = true; };
    request.onsuccess = () => {
      const db = request.result;
      if (createdDuringProbe || requiredStores.some((store) => !db.objectStoreNames.contains(store))) {
        db.close();
        if (createdDuringProbe) {
          const removal = indexedDB.deleteDatabase(databaseName);
          removal.onsuccess = () => resolve(null);
          removal.onerror = () => resolve(null);
          removal.onblocked = () => resolve(null);
        } else resolve(null);
        return;
      }
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن المزامنة السابق."));
    request.onblocked = () => resolve(null);
  });
}


export type OfflineConflictRecord = {
  userId: number;
  tenantId?: number;
  siteId: number;
  operationId: string;
  kind: string;
  outcome: "conflict";
  message: string;
  createdAt: number;
  updatedAt: number;
  localPayload?: unknown;
};

/** Persist unresolved conflicts independently of transient component state. */
export async function upsertOfflineConflict(record: OfflineConflictRecord): Promise<void> {
  if (!Number.isSafeInteger(record.userId) || record.userId < 1 ||
      !Number.isSafeInteger(record.siteId) || record.siteId < 1 || !record.operationId) {
    throw new Error("نطاق سجل التعارض المحلي غير صالح.");
  }
  const db = await openOfflineWorkspaceDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("conflicts", "readwrite");
    tx.objectStore("conflicts").put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر حفظ سجل التعارض.")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("أُلغِي حفظ سجل التعارض.")); };
  });
}

export async function listOfflineConflicts(options: { userId: number; siteId?: number }): Promise<OfflineConflictRecord[]> {
  if (!Number.isSafeInteger(options.userId) || options.userId < 1) return [];
  const db = await openOfflineWorkspaceDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("conflicts", "readonly");
    const request = tx.objectStore("conflicts").getAll();
    request.onsuccess = () => resolve((request.result as OfflineConflictRecord[])
      .filter((row) => row.userId === options.userId && (options.siteId === undefined || row.siteId === options.siteId))
      .sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error ?? new Error("تعذر تحميل سجل التعارضات."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر تحميل سجل التعارضات.")); };
  });
}

export async function removeOfflineConflict(userId: number, operationId: string): Promise<void> {
  const db = await openOfflineWorkspaceDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("conflicts", "readwrite");
    tx.objectStore("conflicts").delete([userId, operationId]);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر حذف سجل التعارض.")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("أُلغي حذف سجل التعارض.")); };
  });
}
