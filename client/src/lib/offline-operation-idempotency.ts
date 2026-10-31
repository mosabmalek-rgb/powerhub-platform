const DATABASE_NAME = "powerhub-operation-idempotency";
const DATABASE_VERSION = 1;
const STORE_NAME = "operations";
export const STABLE_OPERATION_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type StableOperationRecord = {
  key: string;
  operationKey: string;
  createdAt: number;
};

export type StableOperationScope = {
  userId: number;
  siteId: number;
  kind: string;
  payload: unknown;
};

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("لا يمكن إنشاء مفتاح عملية لقيمة رقمية غير صالحة.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((entry) => entry === undefined ? "null" : canonicalValue(entry)).join(",") + "]";
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) {
      throw new Error("بيانات العملية يجب أن تكون كائنًا تسلسليًا عاديًا.");
    }
    const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalValue(object[key])).join(",") + "}";
  }
  throw new Error("تحتوي بيانات العملية على قيمة غير قابلة للتسلسل.");
}

export function canonicalizeOperationPayload(payload: unknown): string {
  return canonicalValue(payload);
}

export async function fingerprintOperationPayload(payload: unknown): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle || typeof TextEncoder === "undefined") {
    throw new Error("التشفير الآمن غير متاح؛ لم تُرسل العملية.");
  }
  const bytes = new TextEncoder().encode(canonicalizeOperationPayload(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("التخزين المحلي الآمن غير متاح؛ لم تُرسل العملية."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("byCreatedAt", "createdAt", { unique: false });
        store.createIndex("byOperationKey", "operationKey", { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن مفاتيح العمليات المحلية."));
    request.onblocked = () => reject(new Error("مخزن مفاتيح العمليات مشغول في تبويب آخر؛ لم تُرسل العملية."));
  });
}

function validScope(scope: StableOperationScope) {
  return Number.isSafeInteger(scope.userId) && scope.userId > 0 &&
    Number.isSafeInteger(scope.siteId) && scope.siteId > 0 &&
    typeof scope.kind === "string" && scope.kind.trim().length >= 2 &&
    scope.kind.length <= 100;
}

/**
 * Returns the same server idempotency key for the same user/site/action/payload
 * until a confirmed response clears it. The payload itself is never persisted.
 * A readwrite IndexedDB transaction serializes concurrent tabs.
 */
export async function getStableOperationKey(scope: StableOperationScope): Promise<string> {
  if (!validScope(scope)) throw new Error("نطاق العملية غير صالح؛ لم تُرسل العملية.");
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("مولّد معرف العملية الآمن غير متاح؛ لم تُرسل العملية.");
  }
  const fingerprint = await fingerprintOperationPayload(scope.payload);
  const key = [scope.userId, scope.siteId, scope.kind.trim(), fingerprint].join(":");
  const now = Date.now();
  const database = await openDatabase();

  return new Promise<string>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(key);
    let operationKey: string | undefined;
    let failure: Error | undefined;

    getRequest.onsuccess = () => {
      try {
        const existing = getRequest.result as StableOperationRecord | undefined;
        if (existing && existing.createdAt <= now && now - existing.createdAt < STABLE_OPERATION_KEY_TTL_MS &&
            typeof existing.operationKey === "string" && existing.operationKey.length >= 8) {
          operationKey = existing.operationKey;
        } else {
          operationKey = crypto.randomUUID();
          const record: StableOperationRecord = { key, operationKey, createdAt: now };
          store.put(record);
        }
        const expiryRequest = store.index("byCreatedAt").openCursor(IDBKeyRange.upperBound(now - STABLE_OPERATION_KEY_TTL_MS));
        expiryRequest.onsuccess = () => {
          const cursor = expiryRequest.result;
          if (cursor) {
            if (cursor.primaryKey !== key) cursor.delete();
            cursor.continue();
          }
        };
        expiryRequest.onerror = () => {
          failure = new Error("تعذر تنظيف مفاتيح العمليات القديمة.");
          try { transaction.abort(); } catch { /* transaction may already be aborting */ }
        };
      } catch (error) {
        failure = error instanceof Error ? error : new Error("تعذر تجهيز مفتاح العملية.");
        try { transaction.abort(); } catch { /* transaction may already be aborting */ }
      }
    };
    getRequest.onerror = () => {
      failure = getRequest.error ?? new Error("تعذر قراءة مفتاح العملية السابق.");
      try { transaction.abort(); } catch { /* transaction may already be aborting */ }
    };
    transaction.oncomplete = () => {
      database.close();
      if (failure) reject(failure);
      else if (operationKey) resolve(operationKey);
      else reject(new Error("لم يُنشأ مفتاح عملية ثابت."));
    };
    transaction.onerror = () => {
      const error = transaction.error;
      database.close();
      reject(failure ?? error ?? new Error("فشلت معاملة مفتاح العملية."));
    };
    transaction.onabort = () => {
      const error = transaction.error;
      database.close();
      reject(failure ?? error ?? new Error("أُلغيت معاملة مفتاح العملية."));
    };
  });
}

/** Remove an intent key only after the server has confirmed the operation. */
export async function clearStableOperationKey(operationKey: string): Promise<void> {
  if (!operationKey) return;
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.index("byOperationKey").openCursor(IDBKeyRange.only(operationKey));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    request.onerror = () => {
      try { transaction.abort(); } catch { /* transaction may already be aborting */ }
    };
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { const error = transaction.error; database.close(); reject(error ?? new Error("تعذر تنظيف مفتاح العملية.")); };
    transaction.onabort = () => { const error = transaction.error; database.close(); reject(error ?? new Error("أُلغيت عملية تنظيف مفتاح العملية.")); };
  });
}
