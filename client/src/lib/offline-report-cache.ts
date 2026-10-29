export type CachedReportSnapshot = {
  key: string;
  userId: number;
  siteId: number;
  scope: "branch" | "all";
  startDate: string;
  endDate: string;
  report: unknown;
  savedAt: number;
};

const databaseName = "powerhub-offline-report-cache";
const storeName = "snapshots";
export const OFFLINE_REPORT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REPORT_SNAPSHOTS = 50;


export type ReportSnapshotScope = Pick<CachedReportSnapshot, "userId" | "siteId" | "scope" | "startDate" | "endDate">;

/**
 * Returns a persisted report only for the exact active identity and filter scope.
 * Financial report snapshots must not bleed between users, branches, periods or
 * report scopes when filters change before IndexedDB finishes loading.
 */
export function getUsableReportSnapshot(
  snapshot: CachedReportSnapshot | null | undefined,
  input: ReportSnapshotScope,
  options: { authorizationDenied?: boolean; accessAllowed?: boolean; now?: number } = {},
): CachedReportSnapshot | undefined {
  const now = options.now ?? Date.now();
  if (options.authorizationDenied || options.accessAllowed === false || !snapshot) return undefined;
  if (snapshot.userId !== input.userId ||
      snapshot.siteId !== input.siteId ||
      snapshot.scope !== input.scope ||
      snapshot.startDate !== input.startDate ||
      snapshot.endDate !== input.endDate) return undefined;
  if (!Number.isFinite(snapshot.savedAt) || snapshot.savedAt > now ||
      now - snapshot.savedAt >= OFFLINE_REPORT_CACHE_TTL_MS) return undefined;
  return snapshot;
}

function cacheKey(input: Pick<CachedReportSnapshot, "userId" | "siteId" | "scope" | "startDate" | "endDate">) {
  return [input.userId, input.siteId, input.scope, input.startDate, input.endDate].join(":");
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("لا يدعم هذا المتصفح تخزين التقرير محلياً."));
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "key" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن التقارير المحلي."));
  });
}

async function request<T>(mode: IDBTransactionMode, callback: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const operation = callback(transaction.objectStore(storeName));
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error("تعذر تحديث لقطة التقرير المحلية."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("تعذر حفظ لقطة التقرير المحلية.")); };
  });
}

export async function saveReportSnapshot(input: Omit<CachedReportSnapshot, "key" | "savedAt">) {
  const snapshot: CachedReportSnapshot = { ...input, key: cacheKey(input), savedAt: Date.now() };
  await request("readwrite", (store) => store.put(snapshot));
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const all = store.getAll();
    all.onsuccess = () => {
      const rows = (all.result as CachedReportSnapshot[])
        .filter((row) => Number.isFinite(row.savedAt) && Date.now() - row.savedAt < OFFLINE_REPORT_CACHE_TTL_MS)
        .sort((a, b) => b.savedAt - a.savedAt);
      const keep = new Set(rows.slice(0, MAX_REPORT_SNAPSHOTS).map((row) => row.key));
      for (const row of all.result as CachedReportSnapshot[]) if (!keep.has(row.key)) store.delete(row.key);
    };
    all.onerror = () => { transaction.abort(); };
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("تعذر تنظيف لقطات التقارير القديمة.")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("تم إلغاء تنظيف لقطات التقارير.")); };
  });
  return snapshot;
}

export async function loadReportSnapshot(input: Pick<CachedReportSnapshot, "userId" | "siteId" | "scope" | "startDate" | "endDate">) {
  const snapshot = await request<CachedReportSnapshot | undefined>("readonly", (store) => store.get(cacheKey(input)));
  if (!snapshot) return undefined;
  if (!Number.isFinite(snapshot.savedAt) || Date.now() - snapshot.savedAt >= OFFLINE_REPORT_CACHE_TTL_MS) {
    await request("readwrite", (store) => store.delete(snapshot.key));
    return undefined;
  }
  return snapshot;
}
