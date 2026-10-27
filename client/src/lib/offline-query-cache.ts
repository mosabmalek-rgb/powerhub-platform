import type { Query, QueryClient } from "@tanstack/react-query";
import superjson from "superjson";

const DATABASE_NAME = "powerhub-offline-cache";
const DATABASE_VERSION = 2;
const QUERY_STORE = "queries";
const AUTH_STORE = "auth-users";
export const OFFLINE_QUERY_CACHE_MAX_RECORDS_PER_USER = 200;
export const OFFLINE_QUERY_CACHE_MAX_RECORD_BYTES = 2 * 1024 * 1024;
let successfulWritesSincePrune = 0;
let pruneInFlight: Promise<void> | null = null;

const CACHEABLE_PROCEDURES = new Set([
  "sites",
  "subscribers",
  "generators",
  "readings",
  "tariffs",
  "schedules",
]);

// Only these list procedures currently have a corresponding Delta reconciliation
// path. Other cached lists retain their original age and must refetch normally.
const DELTA_SYNC_PROCEDURES = new Set(["sites", "subscribers", "generators", "readings", "tariffs"]);

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
  expiresAt: number | null;
};

type OfflineAuthUserRecord = {
  userId: string;
  serializedUser: string;
  updatedAt: number;
};

function getPowerHubQuerySegments(queryKey: readonly unknown[]) {
  const first = queryKey[0];
  if (Array.isArray(first)) return first.filter((part): part is string => typeof part === "string");
  if (typeof first === "string" && first.includes(".")) return first.split(".");
  if (typeof first === "string") return queryKey.slice(0, 3).filter((part): part is string => typeof part === "string");
  return [];
}

const SUBSCRIBER_DIRECTORY_PAGE_SIZE = 20;
const MAX_CACHEABLE_SUBSCRIBER_DIRECTORY_PAGE = 200;
const SUBSCRIBER_DIRECTORY_INPUT_KEYS = new Set([
  "siteId",
  "page",
  "pageSize",
  "search",
  "subscriptionType",
]);

function getOfflineQueryInput(queryKey: readonly unknown[]): Record<string, unknown> | null {
  const options = queryKey[1];
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const wrapper = options as Record<string, unknown>;
  const input = Object.prototype.hasOwnProperty.call(wrapper, "input") ? wrapper.input : wrapper;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function isSafeUnfilteredSubscriberDirectoryPage(queryKey: readonly unknown[]) {
  const input = getOfflineQueryInput(queryKey);
  if (!input || Object.keys(input).some((key) => !SUBSCRIBER_DIRECTORY_INPUT_KEYS.has(key))) return false;
  return Number.isSafeInteger(input.siteId) && Number(input.siteId) > 0 &&
    Number.isSafeInteger(input.page) && Number(input.page) >= 1 &&
    Number(input.page) <= MAX_CACHEABLE_SUBSCRIBER_DIRECTORY_PAGE &&
    input.pageSize === SUBSCRIBER_DIRECTORY_PAGE_SIZE &&
    input.search === "" &&
    input.subscriptionType === undefined;
}

const OFFLINE_PAGE_READ_INPUT_KEYS: Record<string, ReadonlySet<string>> = {
  "readings.page": new Set(["siteId", "limit"]),
  "invoices.page": new Set(["siteId", "limit", "cursor"]),
  "payments.page": new Set(["siteId", "limit", "cursor"]),
  "expenses.page": new Set(["siteId", "limit", "startDate", "endDate", "companyAccountId"]),
};

function isValidOfflineDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Cache only bounded, site-scoped page snapshots whose inputs are explicitly
 * known. These pages are display snapshots, not offline financial authority;
 * until their server change-feed adapters exist, they are deliberately not
 * marked Delta-backed and must refresh from their exact page key on reconnect.
 */
function isSafeScopedOfflinePage(queryKey: readonly unknown[], segments: string[]) {
  if (segments.length !== 3 || segments[2] !== "page") return false;
  const procedure = `${segments[1]}.${segments[2]}`;
  const allowedKeys = OFFLINE_PAGE_READ_INPUT_KEYS[procedure];
  if (!allowedKeys) return false;

  const input = getOfflineQueryInput(queryKey);
  if (!input || Object.keys(input).some((key) => !allowedKeys.has(key))) return false;
  if (!Number.isSafeInteger(input.siteId) || Number(input.siteId) < 1) return false;
  if (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 200)) return false;

  if ((procedure === "invoices.page" || procedure === "payments.page") &&
      input.cursor !== undefined &&
      (typeof input.cursor !== "string" || input.cursor.length === 0 || input.cursor.length > 500)) return false;

  if (procedure === "expenses.page") {
    const hasStart = input.startDate !== undefined;
    const hasEnd = input.endDate !== undefined;
    if (hasStart !== hasEnd) return false;
    if (hasStart && (!isValidOfflineDate(input.startDate) || !isValidOfflineDate(input.endDate) ||
        String(input.startDate) > String(input.endDate))) return false;
    if (input.companyAccountId !== undefined &&
        (!Number.isSafeInteger(input.companyAccountId) || Number(input.companyAccountId) < 1)) return false;
  }
  return true;
}

export function isOfflineCacheableQueryKey(queryKey: readonly unknown[]) {
  const segments = getPowerHubQuerySegments(queryKey);
  if (segments[0] !== "powerhub") return false;
  // Explicit site-scoped page allowlist is evaluated before BLOCKED_PROCEDURES:
  // only the named read pages above may persist, never their list/mutation/summaries.
  if (isSafeScopedOfflinePage(queryKey, segments)) return true;
  if (segments.some((value) => BLOCKED_PROCEDURES.has(value))) return false;

  // Cache only the unfiltered, fixed-size subscriber directory pages. Search
  // results and type-filtered pages may contain a user's ad-hoc selections and
  // are intentionally not persisted. The input contract also bounds page size
  // and rejects extra query fields so unrelated procedures cannot opt in.
  if (segments[1] === "subscribers" && segments[2] === "directoryPage") {
    return isSafeUnfilteredSubscriberDirectoryPage(queryKey);
  }

  // Only stable whole-list query shapes are persisted. Search pages, details,
  // summaries, mutations and other methods under an otherwise cacheable router
  // must opt in explicitly rather than inheriting permission from the router name.
  if (segments.length < 3 || segments[2] !== "list") return false;
  return CACHEABLE_PROCEDURES.has(segments[1] ?? "");
}

export function isDeltaSyncBackedQueryKey(queryKey: readonly unknown[]) {
  const segments = getPowerHubQuerySegments(queryKey);
  if (!isOfflineCacheableQueryKey(queryKey) || segments.length < 3 || segments[0] !== "powerhub") return false;

  // Invoice history uses an object with items/hasNext/nextCursor rather than a bare list.
  if (segments[1] === "invoices" && segments[2] === "page") return true;

  return segments[2] === "list" && DELTA_SYNC_PROCEDURES.has(segments[1] ?? "");
}

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
      const data = superjson.parse(record.serializedData);
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

export async function persistOfflineQuery(query: Query, userId: string, now = Date.now()) {
  if (query.state.status !== "success" || query.state.data === undefined) return;
  if (!isOfflineCacheableQueryKey(query.queryKey)) return;

  const serializedQueryKey = offlineQueryCacheKey(query.queryKey);
  const serializedData = superjson.stringify(query.state.data);
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
