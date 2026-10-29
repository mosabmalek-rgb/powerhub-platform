export type OfflinePaymentDocumentationApprovalSnapshot = {
  id: number;
  userId: number;
  siteId: number;
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
const dbVersion = 2;
export const PAYMENT_DOCUMENTATION_APPROVAL_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

function isPositiveSafeId(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

/** Composite identity keeps offline approval snapshots isolated by user and branch. */
export function paymentDocumentationApprovalSnapshotKey(userId: number, siteId: number, requestId: number) {
  if (![userId, siteId, requestId].every(isPositiveSafeId)) {
    throw new Error("نطاق لقطة اعتماد توثيق الدفع غير صالح.");
  }
  return `user:${userId}:site:${siteId}:request:${requestId}`;
}

/** Shared pure filter for tests and IndexedDB reads; never returns another user's rows. */
export function filterPaymentDocumentationApprovalSnapshots(
  rows: readonly OfflinePaymentDocumentationApprovalSnapshot[],
  input: { userId: number; siteId: number; now?: number },
) {
  if (!isPositiveSafeId(input.userId) || !isPositiveSafeId(input.siteId)) return [];
  const now = input.now ?? Date.now();
  return rows
    .filter((row) => row.userId === input.userId && row.siteId === input.siteId)
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
      // Version 1 stored rows by site/request only. Their owning user cannot be
      // proven, so discard those ambiguous snapshots rather than reassign them.
      if (event.oldVersion < 2 && db.objectStoreNames.contains(storeName)) {
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

export async function savePaymentDocumentationApprovalSnapshots(
  userId: number,
  siteId: number,
  rows: PaymentDocumentationApprovalSnapshotInput[],
) {
  if (!isPositiveSafeId(userId) || !isPositiveSafeId(siteId)) {
    throw new Error("نطاق لقطة اعتماد توثيق الدفع غير صالح.");
  }
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const now = Date.now();
    for (const row of rows) {
      if (!isPositiveSafeId(row.id) || row.status !== "pending") continue;
      store.put({
        key: paymentDocumentationApprovalSnapshotKey(userId, siteId, row.id),
        ...row,
        userId,
        siteId,
        savedAt: now,
      });
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("تعذر حفظ لقطات اعتماد توثيق الدفع.")); };
  });
}

export async function listPaymentDocumentationApprovalSnapshots(userId: number, siteId: number) {
  if (!isPositiveSafeId(userId) || !isPositiveSafeId(siteId)) return [];
  const db = await open();
  return new Promise<OfflinePaymentDocumentationApprovalSnapshot[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => {
      resolve(filterPaymentDocumentationApprovalSnapshots(
        request.result as OfflinePaymentDocumentationApprovalSnapshot[],
        { userId, siteId },
      ));
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("تعذر قراءة لقطات اعتماد توثيق الدفع.")); };
  });
}
