export type OfflinePaymentDocumentationApprovalSnapshot = {
  id: number;
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

const dbName = "powerhub-offline-payment-documentation-approvals";
const storeName = "pending_approvals";
export const PAYMENT_DOCUMENTATION_APPROVAL_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function savePaymentDocumentationApprovalSnapshots(siteId: number, rows: OfflinePaymentDocumentationApprovalSnapshot[]) {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const now = Date.now();
    for (const row of rows) {
      store.put({ key: `${siteId}:${row.id}`, ...row, siteId, savedAt: now });
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function listPaymentDocumentationApprovalSnapshots(siteId: number) {
  const db = await open();
  return new Promise<OfflinePaymentDocumentationApprovalSnapshot[]>((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => {
      const now = Date.now();
      resolve((request.result as OfflinePaymentDocumentationApprovalSnapshot[])
        .filter(row => row.siteId === siteId && now - row.savedAt <= PAYMENT_DOCUMENTATION_APPROVAL_SNAPSHOT_TTL_MS)
        .sort((a,b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()));
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
