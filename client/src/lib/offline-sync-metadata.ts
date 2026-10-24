import { openLegacyOfflineDatabaseIfPresent, openOfflineWorkspaceDatabase } from "./offline-workspace-db";
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

const legacyDatabaseName = "powerhub-offline-sync";
const storeName = "syncMetadata";

export class OfflineSyncMetadataError extends Error {}

function assertAvailable() {
  if (typeof indexedDB === "undefined") {
    throw new OfflineSyncMetadataError("لا يدعم هذا المتصفح حفظ حالة المزامنة محلياً.");
  }
}


let legacyMetadataMigration: Promise<void> | null = null;

async function migrateLegacyMetadataDatabase(target: IDBDatabase) {
  const legacy = await openLegacyOfflineDatabaseIfPresent(legacyDatabaseName, ["metadata"]);
  if (!legacy) return;
  const records = await new Promise<SyncMetadataRecord[]>((resolve, reject) => {
    const tx = legacy.transaction("metadata", "readonly");
    const request = tx.objectStore("metadata").getAll();
    let rows: SyncMetadataRecord[] = [];
    request.onsuccess = () => { rows = request.result as SyncMetadataRecord[]; };
    request.onerror = () => { try { tx.abort(); } catch {} };
    tx.oncomplete = () => { legacy.close(); resolve(rows); };
    tx.onerror = () => { legacy.close(); reject(tx.error ?? new OfflineSyncMetadataError("تعذر قراءة حالات المزامنة القديمة.")); };
    tx.onabort = () => { legacy.close(); reject(tx.error ?? new OfflineSyncMetadataError("أُلغيت قراءة حالات المزامنة القديمة.")); };
  });
  await new Promise<void>((resolve, reject) => {
    const tx = target.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => {
      const existing = new Set((request.result as SyncMetadataRecord[]).map((row) => row.operationId));
      for (const record of records) if (!existing.has(record.operationId)) store.put(record);
    };
    request.onerror = () => { try { tx.abort(); } catch {} };
    tx.oncomplete = () => {
      resolve();
      const removal = indexedDB.deleteDatabase(legacyDatabaseName);
      removal.onerror = () => undefined;
      removal.onblocked = () => undefined;
    };
    tx.onerror = () => reject(tx.error ?? new OfflineSyncMetadataError("تعذر ترحيل حالات المزامنة القديمة."));
    tx.onabort = () => reject(tx.error ?? new OfflineSyncMetadataError("أُلغي ترحيل حالات المزامنة القديمة."));
  });
}

async function openDatabase() {
  const db = await openOfflineWorkspaceDatabase();
  if (!legacyMetadataMigration) {
    legacyMetadataMigration = migrateLegacyMetadataDatabase(db).catch((error) => {
      console.warn("[PowerHub] Legacy outbox metadata migration deferred; operation drafts remain intact.", error);
    });
  }
  await legacyMetadataMigration;
  return db;
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
