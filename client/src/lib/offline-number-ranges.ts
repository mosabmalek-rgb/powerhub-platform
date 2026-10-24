export type OfflineNumberKind = "subscriber" | "invoice";

export type OfflineNumberScope = {
  userId: number;
  tenantId: number;
  siteId: number;
  deviceId: string;
};

export type OfflineNumberGrant = OfflineNumberScope & {
  id: string;
  numberKind: OfflineNumberKind;
  partitionKey: string;
  reservedValues: string[];
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number | null;
};

export type OfflineNumberClaim = OfflineNumberScope & {
  id: string;
  grantId: string;
  numberKind: OfflineNumberKind;
  partitionKey: string;
  numberValue: string;
  clientOperationId: string;
  entityType: "subscriber" | "invoice";
  createdAt: number;
};

const DATABASE_NAME = "powerhub-offline-workspace";
const DATABASE_VERSION = 2;
const GRANTS_STORE = "grants";
const CLAIMS_STORE = "claims";

export class OfflineNumberRangeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "OfflineNumberRangeError";
  }
}

function fail(code: string, message: string): never {
  throw new OfflineNumberRangeError(message, code);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validPositiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

export function formatOfflineNumber(kind: OfflineNumberKind, partitionKey: string, value: string) {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) fail("NUMBER_INVALID", "قيمة الرقم المحجوز غير صالحة.");
  if (kind === "subscriber") {
    if (partitionKey !== "global" || !/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 999999) {
      fail("SUBSCRIBER_NUMBER_INVALID", "رقم المشترك لا يطابق الصيغة العالمية المعتمدة.");
    }
    return `SUB-${value.padStart(6, "0")}`;
  }
  if (!/^\d{4}$/.test(partitionKey) || Number(partitionKey) < 1000 || Number(partitionKey) > 9999) {
    fail("INVOICE_PARTITION_INVALID", "سنة الفاتورة غير صالحة.");
  }
  if (Number(value) > 99_999_999) fail("INVOICE_NUMBER_EXHAUSTED", "تجاوز رقم الفاتورة نطاق الصيغة الرسمية ذات الثمانية أرقام.");
  return `INV-${partitionKey}-${value.padStart(8, "0")}`;
}

export function validateOfflineNumberGrant(grant: OfflineNumberGrant, now = Date.now()) {
  if (!grant.id || !isUuid(grant.id) || !isUuid(grant.deviceId)) fail("GRANT_ID_INVALID", "معرّف حجز الأرقام أو الجهاز غير صالح.");
  if (![grant.userId, grant.tenantId, grant.siteId].every(validPositiveInteger)) fail("GRANT_SCOPE_INVALID", "نطاق حجز الأرقام غير مكتمل.");
  if (grant.revokedAt) fail("GRANT_REVOKED", "تم إلغاء حجز الأرقام.");
  if (!Number.isFinite(grant.issuedAt) || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= grant.issuedAt) {
    fail("GRANT_DATES_INVALID", "تواريخ حجز الأرقام غير صالحة.");
  }
  if (grant.expiresAt <= now) fail("GRANT_EXPIRED", "انتهت صلاحية حجز الأرقام؛ يلزم الاتصال بالخادم لحجز نطاق جديد.");
  if (grant.reservedValues.length < 1 || grant.reservedValues.length > 200) fail("GRANT_SIZE_INVALID", "حجم نطاق الأرقام غير صالح.");
  if (new Set(grant.reservedValues).size !== grant.reservedValues.length) fail("GRANT_DUPLICATE_VALUES", "يحتوي نطاق الأرقام على أرقام مكررة.");
  for (const value of grant.reservedValues) formatOfflineNumber(grant.numberKind, grant.partitionKey, value);
  return true;
}

export function selectNextAvailableOfflineNumber(input: {
  grant: OfflineNumberGrant;
  claims: readonly OfflineNumberClaim[];
  scope: OfflineNumberScope;
  clientOperationId: string;
  entityType: "subscriber" | "invoice";
  now?: number;
}) {
  const { grant, claims, scope, clientOperationId, entityType } = input;
  const now = input.now ?? Date.now();
  validateOfflineNumberGrant(grant, now);
  if (
    grant.userId !== scope.userId ||
    grant.tenantId !== scope.tenantId ||
    grant.siteId !== scope.siteId ||
    grant.deviceId !== scope.deviceId
  ) fail("GRANT_SCOPE_MISMATCH", "حجز الأرقام لا يخص المستخدم أو المستأجر أو الفرع أو الجهاز الحالي.");
  if (!clientOperationId.trim()) fail("OPERATION_ID_REQUIRED", "يلزم معرّف ثابت للعملية.");
  if ((grant.numberKind === "subscriber") !== (entityType === "subscriber")) {
    fail("NUMBER_KIND_MISMATCH", "نوع الرقم لا يتوافق مع العملية المطلوبة.");
  }

  const replay = claims.find((claim) =>
    claim.userId === scope.userId &&
    claim.clientOperationId === clientOperationId &&
    claim.entityType === entityType
  );
  if (replay) {
    if (
      replay.grantId !== grant.id ||
      replay.tenantId !== scope.tenantId ||
      replay.siteId !== scope.siteId ||
      replay.deviceId !== scope.deviceId
    ) fail("OPERATION_IDEMPOTENCY_MISMATCH", "معرّف العملية مستخدم سابقًا ضمن نطاق مختلف.");
    return { claim: replay, replayed: true, formattedNumber: formatOfflineNumber(replay.numberKind, replay.partitionKey, replay.numberValue) };
  }

  const usedValues = new Set(claims.filter((claim) => claim.grantId === grant.id).map((claim) => claim.numberValue));
  const numberValue = grant.reservedValues.find((value) => !usedValues.has(value));
  if (!numberValue) fail("GRANT_EXHAUSTED", "استهلكت جميع الأرقام المحجوزة؛ يلزم حجز نطاق جديد عند الاتصال.");
  return {
    claim: null,
    replayed: false,
    numberValue,
    formattedNumber: formatOfflineNumber(grant.numberKind, grant.partitionKey, numberValue),
  };
}

function openDatabase() {
  if (typeof indexedDB === "undefined") fail("INDEXEDDB_UNAVAILABLE", "لا يدعم هذا المتصفح التخزين المحلي لنطاقات الأرقام.");
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // One operational IndexedDB contains the outbox and its number reservations.
      if (!db.objectStoreNames.contains("operations")) {
        db.createObjectStore("operations", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(GRANTS_STORE)) {
        const grants = db.createObjectStore(GRANTS_STORE, { keyPath: "id" });
        grants.createIndex("byScope", ["userId", "tenantId", "siteId", "deviceId"], { unique: false });
        grants.createIndex("byExpiry", "expiresAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(CLAIMS_STORE)) {
        const claims = db.createObjectStore(CLAIMS_STORE, { keyPath: "id" });
        claims.createIndex("byGrant", "grantId", { unique: false });
        claims.createIndex("byGrantNumber", ["grantId", "numberValue"], { unique: true });
        claims.createIndex("byOperation", ["userId", "clientOperationId", "entityType"], { unique: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new OfflineNumberRangeError("تعذر فتح مخزن الأرقام المحلي.", "DATABASE_OPEN_FAILED"));
  });
}

export async function persistOfflineNumberGrant(grant: OfflineNumberGrant, now = Date.now()) {
  validateOfflineNumberGrant(grant, now);
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(GRANTS_STORE, "readwrite");
    const store = tx.objectStore(GRANTS_STORE);
    const existingRequest = store.get(grant.id);
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as OfflineNumberGrant | undefined;
      if (existing && (
        existing.userId !== grant.userId ||
        existing.tenantId !== grant.tenantId ||
        existing.siteId !== grant.siteId ||
        existing.deviceId !== grant.deviceId ||
        existing.numberKind !== grant.numberKind ||
        existing.partitionKey !== grant.partitionKey ||
        existing.issuedAt !== grant.issuedAt ||
        existing.expiresAt !== grant.expiresAt ||
        (existing.revokedAt ?? null) !== (grant.revokedAt ?? null) ||
        JSON.stringify(existing.reservedValues) !== JSON.stringify(grant.reservedValues)
      )) {
        tx.abort();
        return;
      }
      store.put(grant);
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new OfflineNumberRangeError("تعذر حفظ نطاق الأرقام المحلي.", "GRANT_PERSIST_FAILED")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new OfflineNumberRangeError("تعارض حفظ نطاق الأرقام المحلي.", "GRANT_PERSIST_CONFLICT")); };
  });
}

export async function listOfflineNumberGrants(scope: OfflineNumberScope, now = Date.now()) {
  const db = await openDatabase();
  return new Promise<OfflineNumberGrant[]>((resolve, reject) => {
    const tx = db.transaction(GRANTS_STORE, "readonly");
    const request = tx.objectStore(GRANTS_STORE).getAll();
    request.onsuccess = () => {
      const grants = (request.result as OfflineNumberGrant[]).filter((grant) =>
        grant.userId === scope.userId &&
        grant.tenantId === scope.tenantId &&
        grant.siteId === scope.siteId &&
        grant.deviceId === scope.deviceId &&
        !grant.revokedAt &&
        grant.expiresAt > now
      );
      resolve(grants);
    };
    request.onerror = () => reject(request.error ?? new OfflineNumberRangeError("تعذر قراءة نطاقات الأرقام المحلية.", "GRANT_LIST_FAILED"));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error ?? new OfflineNumberRangeError("تعذر قراءة نطاقات الأرقام المحلية.", "GRANT_LIST_FAILED")); };
  });
}

export async function claimNextOfflineNumber(input: {
  grantId: string;
  scope: OfflineNumberScope;
  clientOperationId: string;
  entityType: "subscriber" | "invoice";
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const db = await openDatabase();
  return new Promise<{ claim: OfflineNumberClaim; formattedNumber: string; replayed: boolean }>((resolve, reject) => {
    const tx = db.transaction([GRANTS_STORE, CLAIMS_STORE], "readwrite");
    const grantsStore = tx.objectStore(GRANTS_STORE);
    const claimsStore = tx.objectStore(CLAIMS_STORE);
    let output: { claim: OfflineNumberClaim; formattedNumber: string; replayed: boolean } | undefined;
    const grantRequest = grantsStore.get(input.grantId);
    grantRequest.onsuccess = () => {
      try {
        const grant = grantRequest.result as OfflineNumberGrant | undefined;
        if (!grant) fail("GRANT_NOT_FOUND", "نطاق الأرقام غير موجود على هذا الجهاز.");
        const claimsRequest = claimsStore.getAll();
        claimsRequest.onsuccess = () => {
          try {
            const decision = selectNextAvailableOfflineNumber({
              grant,
              claims: claimsRequest.result as OfflineNumberClaim[],
              scope: input.scope,
              clientOperationId: input.clientOperationId,
              entityType: input.entityType,
              now,
            });
            if (decision.replayed && decision.claim) {
              output = { claim: decision.claim, formattedNumber: decision.formattedNumber, replayed: true };
              return;
            }
            const claim: OfflineNumberClaim = {
              id: crypto.randomUUID(),
              grantId: grant.id,
              userId: input.scope.userId,
              tenantId: input.scope.tenantId,
              siteId: input.scope.siteId,
              deviceId: input.scope.deviceId,
              numberKind: grant.numberKind,
              partitionKey: grant.partitionKey,
              numberValue: decision.numberValue!,
              clientOperationId: input.clientOperationId,
              entityType: input.entityType,
              createdAt: now,
            };
            claimsStore.add(claim);
            output = { claim, formattedNumber: decision.formattedNumber, replayed: false };
          } catch (error) {
            tx.abort();
            reject(error);
          }
        };
        claimsRequest.onerror = () => { tx.abort(); reject(claimsRequest.error); };
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    grantRequest.onerror = () => { tx.abort(); reject(grantRequest.error); };
    tx.oncomplete = () => { db.close(); if (output) resolve(output); else reject(new OfflineNumberRangeError("لم ينتج حجز الأرقام نتيجة.", "CLAIM_EMPTY")); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new OfflineNumberRangeError("تعذر حجز الرقم محليًا.", "CLAIM_FAILED")); };
    tx.onabort = () => { db.close(); if (output) return; reject(tx.error ?? new OfflineNumberRangeError("تم إلغاء حجز الرقم المحلي.", "CLAIM_ABORTED")); };
  });
}

export async function clearOfflineNumberDataForUser(userId: number) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([GRANTS_STORE, CLAIMS_STORE], "readwrite");
    for (const storeName of [GRANTS_STORE, CLAIMS_STORE]) {
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => {
        for (const record of request.result as Array<{ userId: number; id: string }>) {
          if (record.userId === userId) store.delete(record.id);
        }
      };
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new OfflineNumberRangeError("تعذر تنظيف نطاقات الأرقام.", "CLEANUP_FAILED")); };
  });
}
