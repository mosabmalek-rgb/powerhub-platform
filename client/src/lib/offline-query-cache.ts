import type { Query, QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import { isOfflineCacheableQueryKey, isDeltaSyncBackedQueryKey } from "./offline-query-policy";
export { isOfflineCacheableQueryKey, isDeltaSyncBackedQueryKey } from "./offline-query-policy";

const DATABASE_NAME = "powerhub-offline-cache";
const DATABASE_VERSION = 2;
const QUERY_STORE = "queries";
const AUTH_STORE = "auth-users";
export const OFFLINE_QUERY_CACHE_MAX_RECORDS_PER_USER = 200;
export const OFFLINE_QUERY_CACHE_MAX_RECORD_BYTES = 2 * 1024 * 1024;
let successfulWritesSincePrune = 0;
let pruneInFlight: Promise<void> | null = null;

type OfflineQueryRecord = {
  key: string;
  userId: string;
  serializedQueryKey: string;
  serializedData: string;
  updatedAt: number;
  expiresAt: number | null;
};

type OfflineAuthUserRecord = {
  userId: string;
  serializedUser: string;
  updatedAt: number;
};

export function offlineQueryCacheKey(queryKey: readonly unknown[]) {
  return superjson.stringify(queryKey);
}

export function isOfflineQueryRecordUsable(
  record: Pick<OfflineQueryRecord, "userId" | "serializedQueryKey" | "expiresAt">,
  userId: string,
  now = Date.now(),
) {
  if (record.userId !== userId) return false;
  if (record.expiresAt !== null && (!Number.isFinite(record.expiresAt) || record.expiresAt <= now)) return false;
  try {
    const queryKey = superjson.parse<readonly unknown[]>(record.serializedQueryKey);
    return isOfflineCacheableQueryKey(queryKey);
  } catch {
    return false;
  }
}

function assertIndexedDb() {
  if (typeof indexedDB === "undefined") throw new Error("لا يدعم هذا المتصفح التخزين المحلي للمزامنة.");
}

function openDatabase() {
  assertIndexedDb();
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(QUERY_STORE)) database.createObjectStore(QUERY_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(AUTH_STORE)) database.createObjectStore(AUTH_STORE, { keyPath: "userId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن Offline المحلي."));
  });
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر الوصول إلى مخزن Offline المحلي."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("تعذر إكمال عملية التخزين المحلي."));
    };
  });
}

async function deleteQueryCacheKeys(keys: readonly string[]) {
  if (!keys.length) return;
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(QUERY_STORE, "readwrite");
    const store = transaction.objectStore(QUERY_STORE);
    for (const key of keys) store.delete(key);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("تعذر تنظيف الكاش المحلي.")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("تم إلغاء تنظيف الكاش المحلي.")); };
  });
}

export async function pruneOfflineQueryCache(now = Date.now()) {
  if (pruneInFlight) return pruneInFlight;
  pruneInFlight = (async () => {
    let records: OfflineQueryRecord[];
    try { records = await withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly", (store) => store.getAll()); } catch { return; }
    const remove = new Set<string>();
    const byUser = new Map<string, OfflineQueryRecord[]>();
    for (const record of records) {
      const expiryValid = record.expiresAt === null || (Number.isFinite(record.expiresAt) && record.expiresAt > now);
      const valid = expiryValid &&
        typeof record.userId === "string" && record.userId.length > 0 &&
        typeof record.serializedData === "string" && typeof record.serializedQueryKey === "string" &&
        isOfflineQueryRecordUsable(record, record.userId, now);
      if (!valid) { remove.add(record.key); continue; }
      const group = byUser.get(record.userId) ?? [];
      group.push(record);
      byUser.set(record.userId, group);
    }
    for (const group of byUser.values()) {
      group.sort((a, b) => b.updatedAt - a.updatedAt);
      for (const record of group.slice(OFFLINE_QUERY_CACHE_MAX_RECORDS_PER_USER)) remove.add(record.key);
    }
    try { await deleteQueryCacheKeys([...remove]); } catch { /* cache maintenance is best effort */ }
  })().finally(() => { pruneInFlight = null; });
  return pruneInFlight;
}

export async function hydrateOfflineQueryCache(
  queryClient: QueryClient,
  userId: string,
  now = Date.now(),
  isStillCurrent: () => boolean = () => true,
) {
  let records: OfflineQueryRecord[] = [];
  try {
    await pruneOfflineQueryCache(now);
    records = await withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly", (store) => store.getAll());
  } catch {
    return 0;
  }

  let hydrated = 0;
  for (const record of records) {
    if (!isStillCurrent()) return hydrated;
    if (!isOfflineQueryRecordUsable(record, userId, now)) continue;
    try {
      const queryKey = superjson.parse<readonly unknown[]>(record.serializedQueryKey);
      // Startup hydration can race the live network. Never overwrite a current
      // response with an older local snapshot just because IndexedDB finished later.
      if (queryClient.getQueryData(queryKey) !== undefined) continue;
      const rawData = superjson.parse(record.serializedData);
      const data = sanitizeOfflineQueryData(queryKey, rawData);
      const safeSerializedData = superjson.stringify(data);
      if (safeSerializedData !== record.serializedData) {
        const sanitizedRecord = { ...record, serializedData: safeSerializedData };
        await withStore("queries", "readwrite", (store) => store.put(sanitizedRecord)).catch(() => undefined);
      }
      // Treat Delta-backed snapshots as fresh only in this page's memory. The
      // durable record keeps its real timestamp; Delta sync remains authoritative.
      const hydratedAt = isDeltaSyncBackedQueryKey(queryKey) ? now : record.updatedAt;
      queryClient.setQueryData(queryKey, data, { updatedAt: hydratedAt });
      hydrated += 1;
    } catch {
      // Ignore individual corrupt entries; a future online response will replace them.
    }
  }
  return hydrated;
}

export function sanitizeOfflineQueryData(queryKey: readonly unknown[], data: unknown): unknown {
  const first = queryKey[0];
  const segments = Array.isArray(first) ? first.filter((part): part is string => typeof part === "string")
    : typeof first === "string" ? first.split(".") : [];
  if (segments[0] !== "powerhub" || segments[1] !== "payments" || segments[2] !== "page" ||
      !data || typeof data !== "object" || Array.isArray(data)) return data;
  const page = data as Record<string, unknown>;
  if (!Array.isArray(page.items)) return data;
  return { ...page, items: page.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const row = item as Record<string, unknown>;
    if (!row.payment || typeof row.payment !== "object" || Array.isArray(row.payment)) return item;
    const payment = row.payment as Record<string, unknown>;
    const hasReceiptImage = Boolean(payment.hasReceiptImage || payment.receiptImageKey ||
      payment.receipt_image_key || payment.receiptImageUrl);
    const { receiptImageUrl: _url, receiptImageKey: _key, receiptImageHash: _hash,
      receipt_image_key: _snakeKey, receipt_image_hash: _snakeHash, ...safePayment } = payment;
    return { ...row, payment: { ...safePayment, hasReceiptImage } };
  }) };
}

export async function persistOfflineQuery(query: Query, userId: string, now = Date.now()) {
  if (query.state.status !== "success" || query.state.data === undefined) return;
  if (!isOfflineCacheableQueryKey(query.queryKey)) return;

  const serializedQueryKey = offlineQueryCacheKey(query.queryKey);
  const safeData = sanitizeOfflineQueryData(query.queryKey, query.state.data);
  const serializedData = superjson.stringify(safeData);
  if (new TextEncoder().encode(serializedData).byteLength > OFFLINE_QUERY_CACHE_MAX_RECORD_BYTES) {
    await deleteQueryCacheKeys([userId + ":" + serializedQueryKey]).catch(() => undefined);
    return;
  }
  const record: OfflineQueryRecord = {
    key: userId + ":" + serializedQueryKey,
    userId,
    serializedQueryKey,
    serializedData,
    updatedAt: query.state.dataUpdatedAt || now,
    // Operational snapshots are retained across days; freshness is handled by sync cursors,
    // not by expiring the whole snapshot on a wall-clock TTL. Size and scope limits still apply.
    expiresAt: null,
  };

  try {
    await withStore("queries", "readwrite", (store) => store.put(record));
    successfulWritesSincePrune += 1;
    if (successfulWritesSincePrune >= 20) {
      successfulWritesSincePrune = 0;
      void pruneOfflineQueryCache(now);
    }
  } catch {
    // Offline persistence is an enhancement; never let it break the live query.
  }
}

export async function clearOfflineQueryCacheForUser(userId: string) {
  try {
    const records = await withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly", (store) => store.getAll());
    await deleteQueryCacheKeys(records.filter((record) => record.userId === userId).map((record) => record.key));
  } catch {
    // Best-effort privacy cleanup must not break the sign-out flow.
  }
}

export async function persistOfflineAuthUser(userId: string, user: unknown) {
  const record: OfflineAuthUserRecord = {
    userId,
    serializedUser: superjson.stringify(user),
    updatedAt: Date.now(),
  };
  try {
    await withStore("auth-users", "readwrite", (store) => store.put(record));
  } catch {
    // Never block authentication on local persistence.
  }
}

export async function getOfflineAuthUser<T = unknown>(userId: string): Promise<T | null> {
  try {
    const record = await withStore<OfflineAuthUserRecord | undefined>("auth-users", "readonly", (store) => store.get(userId));
    if (!record) return null;
    return superjson.parse<T>(record.serializedUser);
  } catch {
    return null;
  }
}

export async function removeOfflineAuthUser(userId: string) {
  try {
    await withStore("auth-users", "readwrite", (store) => store.delete(userId));
  } catch {
    // Best effort only.
  }
}
