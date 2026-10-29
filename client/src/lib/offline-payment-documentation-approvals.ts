export type PaymentDocumentationApprovalStatus = "pending" | "approved" | "rejected" | "all";
export type PaymentDocumentationApprovalPeriod = "current_cycle" | "today" | "specific_day" | "date_range" | "all_time";

export type PaymentDocumentationApprovalSnapshotScopeInput = {
  status: PaymentDocumentationApprovalStatus;
  period: PaymentDocumentationApprovalPeriod;
  specificDate?: string;
  fromDate?: string;
  toDate?: string;
};

export type OfflinePaymentDocumentationApprovalSnapshot = {
  id: number;
  userId: number;
  siteId: number;
  snapshotScope: string;
  savedAt: number;
  invoiceNo: string;
  subscriberName: string;
  subscriberNo: string;
  paymentAmount: number;
  invoiceBalance: number;
  paymentMethod: string;
  destinationAccountId: number;
  submittedAt: string;
  status: "pending";
};

export type PaymentDocumentationApprovalSnapshotInput = Pick<
  OfflinePaymentDocumentationApprovalSnapshot,
  "id" | "invoiceNo" | "subscriberName" | "subscriberNo" | "paymentAmount" |
  "invoiceBalance" | "paymentMethod" | "destinationAccountId" | "submittedAt" | "status"
>;

const dbName = "powerhub-offline-payment-documentation-approvals";
const storeName = "pending_approvals";
const dbVersion = 3;
export const PAYMENT_DOCUMENTATION_APPROVAL_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

function isPositiveSafeId(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Exact query scope for the cached review list. A partial result loaded for one
 * date/status must never be presented as the result of different filters.
 */
export function paymentDocumentationApprovalSnapshotScope(
  input: PaymentDocumentationApprovalSnapshotScopeInput,
): string {
  return JSON.stringify({
    status: input.status,
    period: input.period,
    specificDate: input.period === "specific_day" ? input.specificDate ?? null : null,
    fromDate: input.period === "date_range" ? input.fromDate ?? null : null,
    toDate: input.period === "date_range" ? input.toDate ?? null : null,
  });
}

/** Composite identity isolates a request by user, branch, and exact list filters. */
export function paymentDocumentationApprovalSnapshotKey(
  userId: number, siteId: number, snapshotScope: string, requestId: number,
) {
  if (![userId, siteId, requestId].every(isPositiveSafeId) || !snapshotScope) {
    throw new Error("نطاق لقطة اعتماد توثيق الدفع غير صالح.");
  }
  return `user:${userId}:site:${siteId}:scope:${snapshotScope}:request:${requestId}`;
}

/** Shared pure filter for tests and IndexedDB reads; never returns another user's rows. */
export function filterPaymentDocumentationApprovalSnapshots(
  rows: readonly OfflinePaymentDocumentationApprovalSnapshot[],
  input: { userId: number; siteId: number; snapshotScope: string; now?: number },
) {
  if (!isPositiveSafeId(input.userId) || !isPositiveSafeId(input.siteId) || !input.snapshotScope) return [];
  const now = input.now ?? Date.now();
  return rows
    .filter((row) => row.userId === input.userId && row.siteId === input.siteId &&
      row.snapshotScope === input.snapshotScope)
    .filter((row) => row.status === "pending" && isPositiveSafeId(row.id))
    .filter((row) => Number.isFinite(row.savedAt) && now >= row.savedAt &&
      now - row.savedAt <= PAYMENT_DOCUMENTATION_APPROVAL_SNAPSHOT_TTL_MS)
    .sort((a, b) => {
      const left = Date.parse(b.submittedAt);
      const right = Date.parse(a.submittedAt);
      return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
    });
}

function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // Earlier versions did not separate user identity and filter scope. Their
      // rows cannot be safely attributed or shown as a complete filtered result.
      if (event.oldVersion < 3 && db.objectStoreNames.contains(storeName)) {
        db.deleteObjectStore(storeName);
      }
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Replaces only this user's exact filter-scope snapshot. Empty rows deliberately
 * clear the old subset, so an item approved/rejected online is not left looking pending.
 */
export async function savePaymentDocumentationApprovalSnapshots(
  userId: number,
  siteId: number,
  snapshotScope: string,
  rows: PaymentDocumentationApprovalSnapshotInput[],
) {
  if (!isPositiveSafeId(userId) || !isPositiveSafeId(siteId) || !snapshotScope) {
    throw new Error("نطاق لقطة اعتماد توثيق الدفع غير صالح.");
  }
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const currentRows = store.getAll();
    currentRows.onsuccess = () => {
      const existing = currentRows.result as Array<OfflinePaymentDocumentationApprovalSnapshot & { key: string }>;
      for (const row of existing) {
        if (row.userId === userId && row.siteId === siteId && row.snapshotScope === snapshotScope) {
          store.delete(row.key);
        }
      }
      const now = Date.now();
      for (const row of rows) {
        if (!isPositiveSafeId(row.id) || row.status !== "pending") continue;
        store.put({
          key: paymentDocumentationApprovalSnapshotKey(userId, siteId, snapshotScope, row.id),
          ...row,
          userId,
          siteId,
          snapshotScope,
          savedAt: now,
        });
      }
    };
    currentRows.onerror = () => { try { tx.abort(); } catch { /* transaction may already be inactive */ } };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("تعذر حفظ لقطات اعتماد توثيق الدفع.")); };
  });
}

export async function listPaymentDocumentationApprovalSnapshots(
  userId: number, siteId: number, snapshotScope: string,
) {
  if (!isPositiveSafeId(userId) || !isPositiveSafeId(siteId) || !snapshotScope) return [];
  const db = await open();
  return new Promise<OfflinePaymentDocumentationApprovalSnapshot[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => {
      resolve(filterPaymentDocumentationApprovalSnapshots(
        request.result as OfflinePaymentDocumentationApprovalSnapshot[],
        { userId, siteId, snapshotScope },
      ));
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("تعذر قراءة لقطات اعتماد توثيق الدفع.")); };
  });
}
