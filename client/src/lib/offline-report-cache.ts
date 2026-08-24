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
  return snapshot;
}

export async function loadReportSnapshot(input: Pick<CachedReportSnapshot, "userId" | "siteId" | "scope" | "startDate" | "endDate">) {
  return request<CachedReportSnapshot | undefined>("readonly", (store) => store.get(cacheKey(input)));
}
