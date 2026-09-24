const DATABASE_NAME = "powerhub-offline-auth";
const DATABASE_VERSION = 1;
const LEASE_STORE = "lease";
const KEY_STORE = "keys";
const LEASE_KEY = "active";
const DEVICE_KEY = "device-hmac";
const DEVICE_ID_KEY = "device-id";
const DEVICE_ID_FALLBACK_KEY = "powerhub:device-id";

let memoryDeviceId: string | null = null;

export const OFFLINE_AUTH_LEASE_MS = 48 * 60 * 60 * 1000;

export type OfflineAuthLease = {
  userId: string;
  issuedAt: number;
  expiresAt: number;
};

type StoredLease = OfflineAuthLease & {
  id: typeof LEASE_KEY;
  signature: string;
};

type StoredKey = {
  id: typeof DEVICE_KEY;
  key: CryptoKey;
};

type StoredDeviceId = {
  id: typeof DEVICE_ID_KEY;
  value: string;
};

function assertBrowserCrypto() {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("هذا المتصفح لا يدعم المصادقة المحلية الآمنة.");
  }
}

function assertIndexedDb() {
  if (typeof indexedDB === "undefined") {
    throw new Error("لا يدعم هذا المتصفح التخزين المحلي للمصادقة دون اتصال.");
  }
}

function openDatabase() {
  assertIndexedDb();
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LEASE_STORE)) {
        database.createObjectStore(LEASE_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(KEY_STORE)) {
        database.createObjectStore(KEY_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن المصادقة المحلية."));
  });
}

async function readRecord<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const database = await openDatabase();
  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error("تعذر قراءة بيانات المصادقة المحلية."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("تعذر إكمال قراءة المصادقة المحلية."));
    };
  });
}

async function writeRecord(storeName: string, value: unknown) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("تعذر حفظ المصادقة المحلية."));
    };
  });
}

async function deleteRecord(storeName: string, key: IDBValidKey) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("تعذر إلغاء المصادقة المحلية."));
    };
  });
}

async function getDeviceId() {
  const stored = await readRecord<StoredDeviceId>(KEY_STORE, DEVICE_ID_KEY);
  if (stored?.value && /^[0-9a-f-]{36}$/i.test(stored.value)) return stored.value;
  const value = crypto.randomUUID();
  await writeRecord(KEY_STORE, { id: DEVICE_ID_KEY, value } satisfies StoredDeviceId);
  return value;
}

function readLocalStorageDeviceId() {
  try {
    const stored = window.localStorage.getItem(DEVICE_ID_FALLBACK_KEY);
    return stored && /^[0-9a-f-]{36}$/i.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

function persistLocalStorageDeviceId(value: string) {
  try {
    window.localStorage.setItem(DEVICE_ID_FALLBACK_KEY, value);
  } catch {
    // Private browsing or disabled storage is handled by the memory fallback.
  }
  memoryDeviceId = value;
}

function getFallbackDeviceId() {
  if (memoryDeviceId) return memoryDeviceId;
  const stored = readLocalStorageDeviceId();
  if (stored) {
    memoryDeviceId = stored;
    return stored;
  }
  const value = crypto.randomUUID();
  persistLocalStorageDeviceId(value);
  return value;
}

export async function getPowerHubDeviceId() {
  assertBrowserCrypto();

  // Keep one browser identity even if IndexedDB is temporarily unavailable.
  // Generating a different fallback ID makes the server treat this browser as
  // a second device and can create a login -> workspace -> login loop.
  if (memoryDeviceId) return memoryDeviceId;
  const localStorageId = readLocalStorageDeviceId();
  if (localStorageId) {
    memoryDeviceId = localStorageId;
    return localStorageId;
  }

  try {
    assertIndexedDb();
    const indexedDbId = await getDeviceId();
    persistLocalStorageDeviceId(indexedDbId);
    return indexedDbId;
  } catch {
    return getFallbackDeviceId();
  }
}

async function getDeviceKey() {
  assertBrowserCrypto();
  const stored = await readRecord<StoredKey>(KEY_STORE, DEVICE_KEY);
  if (stored?.key) return stored.key;

  const key = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  ) as CryptoKey;

  await writeRecord(KEY_STORE, { id: DEVICE_KEY, key } satisfies StoredKey);
  return key;
}

function leasePayload(lease: OfflineAuthLease) {
  return JSON.stringify([
    "powerhub-offline-auth-v1",
    lease.userId,
    lease.issuedAt,
    lease.expiresAt,
  ]);
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signLease(lease: OfflineAuthLease) {
  const key = await getDeviceKey();
  const data = new TextEncoder().encode(leasePayload(lease));
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifyLease(lease: StoredLease) {
  try {
    const key = await getDeviceKey();
    const data = new TextEncoder().encode(leasePayload(lease));
    return await crypto.subtle.verify("HMAC", key, base64UrlToBytes(lease.signature), data);
  } catch {
    return false;
  }
}

/**
 * Creates or renews the local 48-hour offline access lease.
 * This function must only be called after a successful online Supabase
 * authentication/validation. It refuses to renew while the browser reports
 * itself offline.
 */
export async function renewOfflineAuthLease(userId: string): Promise<OfflineAuthLease | null> {
  if (!userId || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return null;
  }

  try {
    const issuedAt = Date.now();
    const lease: OfflineAuthLease = {
      userId,
      issuedAt,
      expiresAt: issuedAt + OFFLINE_AUTH_LEASE_MS,
    };
    const signature = await signLease(lease);
    await writeRecord(LEASE_STORE, { id: LEASE_KEY, ...lease, signature } satisfies StoredLease);
    return lease;
  } catch {
    return null;
  }
}

export async function getValidOfflineAuthLease(expectedUserId?: string): Promise<OfflineAuthLease | null> {
  try {
    const stored = await readRecord<StoredLease>(LEASE_STORE, LEASE_KEY);
    if (!stored || stored.expiresAt <= Date.now()) {
      if (stored?.expiresAt !== undefined && stored.expiresAt <= Date.now()) {
        await deleteRecord(LEASE_STORE, LEASE_KEY);
      }
      return null;
    }

    if (expectedUserId && stored.userId !== expectedUserId) {
      return null;
    }

    if (!(await verifyLease(stored))) {
      return null;
    }

    return {
      userId: stored.userId,
      issuedAt: stored.issuedAt,
      expiresAt: stored.expiresAt,
    };
  } catch {
    return null;
  }
}

export async function revokeOfflineAuthLease() {
  try {
    await deleteRecord(LEASE_STORE, LEASE_KEY);
  } catch {
    // Best effort only. The lease has no server-side authority.
  }
}
