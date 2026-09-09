import type { Query, QueryClient } from "@tanstack/react-query";
import superjson from "superjson";

const DATABASE_NAME = "powerhub-offline-cache";
const DATABASE_VERSION = 2;
const QUERY_STORE = "queries";
const AUTH_STORE = "auth-users";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const CACHEABLE_PROCEDURES = new Set([
  "sites",
  "subscribers",
  "generators",
  "readings",
  "tariffs",
  "schedules",
]);

const BLOCKED_PROCEDURES = new Set([
  "admin",
  "auth",
  "messaging",
  "audit",
  "payments",
  "collections",
  "finance",
  "financialDashboard",
  "financialSettlements",
  "companyAccounts",
  "expenses",
  "payroll",
  "attendance",
]);

type OfflineQueryRecord = {
  key: string;
  userId: string;
  serializedQueryKey: string;
  serializedData: string;
  updatedAt: number;
  expiresAt: number;
};

type OfflineAuthUserRecord = {
  userId: string;
  serializedUser: string;
  updatedAt: number;
};

export function isOfflineCacheableQueryKey(queryKey: readonly unknown[]) {
  const strings = collectStrings(queryKey);
  if (!strings.includes("powerhub")) return false;
  if (strings.some((value) => BLOCKED_PROCEDURES.has(value))) return false;
  return strings.some((value) => CACHEABLE_PROCEDURES.has(value));
}

export function offlineQueryCacheKey(queryKey: readonly unknown[]) {
  return superjson.stringify(queryKey);
}

export function isOfflineQueryRecordUsable(
  record: Pick<OfflineQueryRecord, "userId" | "serializedQueryKey" | "expiresAt">,
  userId: string,
  now = Date.now(),
) {
  if (record.userId !== userId || record.expiresAt <= now) return false;
  try {
    const queryKey = superjson.parse<readonly unknown[]>(record.serializedQueryKey);
    return isOfflineCacheableQueryKey(queryKey);
  } catch {
    return false;
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
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

export async function hydrateOfflineQueryCache(queryClient: QueryClient, userId: string, now = Date.now()) {
  let records: OfflineQueryRecord[] = [];
  try {
    records = await withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly", (store) => store.getAll());
  } catch {
    return 0;
  }

  let hydrated = 0;
  for (const record of records) {
    if (!isOfflineQueryRecordUsable(record, userId, now)) continue;
    try {
      const queryKey = superjson.parse<readonly unknown[]>(record.serializedQueryKey);
      const data = superjson.parse(record.serializedData);
      queryClient.setQueryData(queryKey, data, { updatedAt: record.updatedAt });
      hydrated += 1;
    } catch {
      // Ignore individual corrupt entries; a future online response will replace them.
    }
  }
  return hydrated;
}

export async function persistOfflineQuery(query: Query, userId: string, now = Date.now()) {
  if (query.state.status !== "success" || query.state.data === undefined) return;
  if (!isOfflineCacheableQueryKey(query.queryKey)) return;

  const serializedQueryKey = offlineQueryCacheKey(query.queryKey);
  const record: OfflineQueryRecord = {
    key: `${userId}:${serializedQueryKey}`,
    userId,
    serializedQueryKey,
    serializedData: superjson.stringify(query.state.data),
    updatedAt: query.state.dataUpdatedAt || now,
    expiresAt: now + CACHE_TTL_MS,
  };

  try {
    await withStore("queries", "readwrite", (store) => store.put(record));
  } catch {
    // Offline persistence is an enhancement; never let it break the live query.
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
