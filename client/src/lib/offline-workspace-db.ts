/**
 * Canonical IndexedDB schema for operational offline work.
 * All writers use the same DB version so the first opener creates every store.
 * Query cache and authentication intentionally remain isolated in their own DBs.
 */
export const OFFLINE_WORKSPACE_DATABASE_NAME = "powerhub-offline-workspace";
export const OFFLINE_WORKSPACE_DATABASE_VERSION = 5;

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
      const tx = request.transaction!;
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
      ensureStore(db, tx, "fieldReadings", "id", [
        { name: "byUser", keyPath: "userId" },
        { name: "bySite", keyPath: ["userId", "siteId"] },
        { name: "byStatus", keyPath: "status" },
        { name: "byNextAttempt", keyPath: "nextAttemptAt" },
      ]);
      ensureStore(db, tx, "orphanedFieldReadings", "id", [
        { name: "byQuarantineReason", keyPath: "quarantineReason" },
      ]);
      ensureStore(db, tx, "bootstrapState", "scopeKey", [
        { name: "byUser", keyPath: "userId" },
        { name: "bySite", keyPath: ["userId", "tenantId", "siteId"] },
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


let legacyFieldQueueMigration: Promise<void> | null = null;

type LegacyFieldReadingRecord = Record<string, unknown>;
type MigratedFieldReading = {
  work: LegacyFieldReadingRecord & {
    id: string; clientOperationId: string; userId: number; siteId: number;
    kind: "reading_create"; payload: Record<string, unknown>;
    createdAt: number; updatedAt: number; status: "pending" | "failed" | "conflict" | "applied";
  };
  metadata: LegacyFieldReadingRecord & {
    operationId: string; userId: number; siteId: number; kind: "reading_create";
    dependsOn: string[]; attempts: number; nextAttemptAt: number;
    outcome: "pending" | "applied" | "conflict" | "retryable" | "rejected"; updatedAt: number;
  };
  conflict?: OfflineConflictRecord;
};
function migrationNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function mapLegacyFieldReading(raw: LegacyFieldReadingRecord): MigratedFieldReading | {
  quarantine: LegacyFieldReadingRecord & { id: string; quarantinedAt: number; quarantineReason: string };
} {
  const { meterId: _meterId, ...row } = raw as LegacyFieldReadingRecord & { meterId?: unknown };
  void _meterId;
  const now = Date.now();
  const operationId = String(row.clientOperationId ?? row.id ?? crypto.randomUUID());
  const id = String(row.id ?? operationId);
  const userId = Number(row.userId);
  const siteId = Number(row.siteId);
  const subscriberId = Number(row.subscriberId);
  const quarantine = (reason: string) => ({
    quarantine: { ...row, id, quarantinedAt: now, quarantineReason: reason },
  });
  if (!Number.isSafeInteger(userId) || userId < 1) return quarantine("missing-user-scope");
  if (!Number.isSafeInteger(siteId) || siteId < 1) return quarantine("missing-site-scope");
  if (!Number.isSafeInteger(subscriberId) || subscriberId < 1) return quarantine("missing-subscriber-scope");

  const createdAt = migrationNumber(row.createdAt, now);
  const updatedAt = migrationNumber(row.updatedAt, createdAt);
  const status = row.status === "conflict" || row.status === "failed" || row.status === "applied" ? row.status : "pending";
  const error = typeof row.error === "string" ? row.error : undefined;
  const rawKind = row.lastErrorKind;
  const outcome: "pending" | "applied" | "conflict" | "retryable" | "rejected" =
    status === "applied" ? "applied" :
    status === "conflict" || rawKind === "conflict" ? "conflict" :
    status === "failed" ? (rawKind === "terminal" ? "rejected" : "retryable") : "pending";
  const tenantNum = Number(row.tenantId);
  const tenantId = Number.isSafeInteger(tenantNum) && tenantNum > 0 ? tenantNum : undefined;
  const payload: Record<string, unknown> = {
    subscriberId,
    readingValue: String(row.readingValue ?? ""),
    readingAt: String(row.readingAt ?? new Date(createdAt).toISOString()),
    captureMethod: row.captureMethod === "photo" || row.captureMethod === "smart_meter" ? row.captureMethod : "manual",
    ...(typeof row.imageData === "string" ? { imageData: row.imageData } : {}),
    ...(typeof row.imageMime === "string" ? { imageMime: row.imageMime } : {}),
    ...(typeof row.notes === "string" ? { notes: row.notes } : {}),
    ...(typeof row.isReadingReset === "boolean" ? { isReadingReset: row.isReadingReset } : {}),
    ...(typeof row.overrideSameDay === "boolean" ? { overrideSameDay: row.overrideSameDay } : {}),
    ...(typeof row.fieldVerified === "boolean" ? { fieldVerified: row.fieldVerified } : {}),
  };
  const work = {
    id, clientOperationId: operationId, userId,
    ...(tenantId !== undefined ? { tenantId } : {}),
    siteId, kind: "reading_create" as const, payload,
    createdAt, updatedAt, status: status as "pending" | "failed" | "conflict" | "applied",
    ...(error ? { error } : {}),
  };
  const metadata = {
    operationId, userId, ...(tenantId !== undefined ? { tenantId } : {}),
    siteId, kind: "reading_create" as const, dependsOn: [],
    attempts: Math.max(0, Math.floor(migrationNumber(row.attempts, 0))),
    nextAttemptAt: status === "applied" || status === "conflict" || outcome === "rejected"
      ? Number.POSITIVE_INFINITY : migrationNumber(row.nextAttemptAt, createdAt),
    outcome,
    ...(error ? { lastError: error } : {}),
    ...(typeof row.lastErrorCode === "string" ? { lastErrorCode: row.lastErrorCode } : {}),
    updatedAt,
  };
  const conflict: OfflineConflictRecord | undefined = status === "conflict" ? {
    userId, ...(tenantId !== undefined ? { tenantId } : {}), siteId, operationId,
    kind: "reading_create", outcome: "conflict",
    message: error ?? "تعارض قراءة قديم يحتاج إلى مراجعة.",
    createdAt, updatedAt, localPayload: payload,
  } : undefined;
  return { work, metadata, ...(conflict ? { conflict } : {}) };
}

/**
 * Conservatively migrate both the legacy field queue and the temporary v4
 * fieldReadings store into the canonical operations Outbox. Source rows are
 * removed only within the destination transaction after their replacement,
 * metadata, or quarantine record is written.
 */
export async function ensureLegacyFieldReadingsMigrated(target: IDBDatabase): Promise<void> {
  if (!legacyFieldQueueMigration) {
    legacyFieldQueueMigration = (async () => {
      const legacy = await openLegacyOfflineDatabaseIfPresent("powerhub-field-queue", ["readings"]);
      let legacyReadings: LegacyFieldReadingRecord[] = [];
      let legacyOrphans: LegacyFieldReadingRecord[] = [];
      if (legacy) {
        const sourceStores = ["readings", ...(legacy.objectStoreNames.contains("orphaned_readings") ? ["orphaned_readings"] : [])];
        const source = await new Promise<{ readings: LegacyFieldReadingRecord[]; orphaned: LegacyFieldReadingRecord[] }>((resolve, reject) => {
          const tx = legacy.transaction(sourceStores, "readonly");
          const readingsRequest = tx.objectStore("readings").getAll();
          const orphanRequest = sourceStores.includes("orphaned_readings") ? tx.objectStore("orphaned_readings").getAll() : null;
          let readings: LegacyFieldReadingRecord[] = [];
          let orphaned: LegacyFieldReadingRecord[] = [];
          readingsRequest.onsuccess = () => { readings = readingsRequest.result as LegacyFieldReadingRecord[]; };
          if (orphanRequest) orphanRequest.onsuccess = () => { orphaned = orphanRequest.result as LegacyFieldReadingRecord[]; };
          readingsRequest.onerror = () => { try { tx.abort(); } catch {} };
          if (orphanRequest) orphanRequest.onerror = () => { try { tx.abort(); } catch {} };
          tx.oncomplete = () => { legacy.close(); resolve({ readings, orphaned }); };
          tx.onerror = () => { legacy.close(); reject(tx.error ?? new Error("تعذر قراءة طابور القراءات القديم.")); };
          tx.onabort = () => { legacy.close(); reject(tx.error ?? new Error("أُلغي ترحيل طابور القراءات القديم.")); };
        });
        legacyReadings = source.readings;
        legacyOrphans = source.orphaned;
      }

      await new Promise<void>((resolve, reject) => {
        const tx = target.transaction(["operations", "syncMetadata", "conflicts", "fieldReadings", "orphanedFieldReadings"], "readwrite");
        const operations = tx.objectStore("operations");
        const metadata = tx.objectStore("syncMetadata");
        const conflicts = tx.objectStore("conflicts");
        const fieldRows = tx.objectStore("fieldReadings");
        const orphanRows = tx.objectStore("orphanedFieldReadings");
        const fieldReq = fieldRows.getAll();
        const operationsReq = operations.getAll();
        const metadataReq = metadata.getAll();
        const conflictsReq = conflicts.getAll();
        const orphanKeysReq = orphanRows.getAllKeys();
        let fieldRecords: LegacyFieldReadingRecord[] = [];
        let existingOperations: Array<Record<string, unknown>> = [];
        let existingMetadata: Array<Record<string, unknown>> = [];
        let existingConflicts: Array<Record<string, unknown>> = [];
        let existingOrphans = new Set<IDBValidKey>();
        let ready = 0;
        let merged = false;
        const merge = () => {
          ready += 1;
          if (ready < 5 || merged) return;
          merged = true;
          const existingIds = new Set(existingOperations.map((row) => String(row.id ?? "")));
          const existingOperationIds = new Set(existingOperations.map((row) => String(row.clientOperationId ?? "")));
          const existingMetadataIds = new Set(existingMetadata.map((row) => String(row.operationId ?? "")));
          const existingConflictKeys = new Set(existingConflicts.map((row) => `${row.userId}|${row.operationId}`));
          const normalized = new Map<string, MigratedFieldReading>();
          const quarantined = new Map<string, LegacyFieldReadingRecord & { id: string; quarantinedAt: number; quarantineReason: string }>();
          for (const raw of [...fieldRecords, ...legacyReadings]) {
            const mapped = mapLegacyFieldReading(raw);
            if ("quarantine" in mapped) {
              if (!quarantined.has(mapped.quarantine.id)) quarantined.set(mapped.quarantine.id, mapped.quarantine);
            } else if (!normalized.has(mapped.work.clientOperationId)) {
              normalized.set(mapped.work.clientOperationId, mapped);
            }
          }
          for (const raw of legacyOrphans) {
            const id = String(raw.id ?? crypto.randomUUID());
            if (!quarantined.has(id)) quarantined.set(id, {
              ...raw, id, quarantinedAt: migrationNumber(raw.quarantinedAt, Date.now()),
              quarantineReason: String(raw.quarantineReason ?? "previously-quarantined"),
            });
          }
          for (const candidate of normalized.values()) {
            const { work, metadata: metaRecord, conflict } = candidate;
            if (!existingIds.has(work.id) && !existingOperationIds.has(work.clientOperationId)) {
              operations.put(work);
              existingIds.add(work.id);
              existingOperationIds.add(work.clientOperationId);
            }
            if (!existingMetadataIds.has(metaRecord.operationId)) {
              metadata.put(metaRecord);
              existingMetadataIds.add(metaRecord.operationId);
            }
            if (conflict) {
              const key = `${conflict.userId}|${conflict.operationId}`;
              if (!existingConflictKeys.has(key)) { conflicts.put(conflict); existingConflictKeys.add(key); }
            }
          }
          for (const orphan of quarantined.values()) {
            if (!existingOrphans.has(orphan.id)) { orphanRows.put(orphan); existingOrphans.add(orphan.id); }
          }
          for (const row of fieldRecords) if (row.id !== undefined) fieldRows.delete(row.id as IDBValidKey);
        };
        fieldReq.onsuccess = () => { fieldRecords = fieldReq.result as LegacyFieldReadingRecord[]; merge(); };
        operationsReq.onsuccess = () => { existingOperations = operationsReq.result as Array<Record<string, unknown>>; merge(); };
        metadataReq.onsuccess = () => { existingMetadata = metadataReq.result as Array<Record<string, unknown>>; merge(); };
        conflictsReq.onsuccess = () => { existingConflicts = conflictsReq.result as Array<Record<string, unknown>>; merge(); };
        orphanKeysReq.onsuccess = () => { existingOrphans = new Set(orphanKeysReq.result); merge(); };
        fieldReq.onerror = () => { try { tx.abort(); } catch {} };
        operationsReq.onerror = () => { try { tx.abort(); } catch {} };
        metadataReq.onerror = () => { try { tx.abort(); } catch {} };
        conflictsReq.onerror = () => { try { tx.abort(); } catch {} };
        orphanKeysReq.onerror = () => { try { tx.abort(); } catch {} };
        tx.oncomplete = () => {
          resolve();
          if (legacy) {
            const removal = indexedDB.deleteDatabase("powerhub-field-queue");
            removal.onerror = () => undefined;
            removal.onblocked = () => undefined;
          }
        };
        tx.onerror = () => reject(tx.error ?? new Error("تعذر ترحيل القراءات إلى Outbox الموحد."));
        tx.onabort = () => reject(tx.error ?? new Error("أُلغي ترحيل القراءات إلى Outbox الموحد."));
      });
    })().catch((error) => {
      legacyFieldQueueMigration = null;
      throw error;
    });
  }
  await legacyFieldQueueMigration;
}
