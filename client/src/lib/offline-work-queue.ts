export type OfflineWorkKind = "subscriber_create" | "subscriber_update" | "invoice_issue" | "payment_create";
export type OfflineWorkStatus = "pending" | "conflict" | "failed" | "applied";

export type SubscriberCreateDraft = {
  fullName: string;
  phone: string;
  address?: string;
  subscriptionType: "residential" | "commercial";
};

export type SubscriberUpdateDraft = SubscriberCreateDraft & {
  subscriberId: number;
  serviceStatus: "active" | "suspended" | "disconnected";
  expectedUpdatedAt: string;
};

export type InvoiceIssueDraft = {
  readingId: number;
  tariffId: number;
  billingPeriod: string;
  dueDate: string;
  discountAmount: number;
};

export type PaymentDraft = {
  subscriberId: number;
  invoiceId?: number;
  paymentNo: string;
  amount: number;
  paymentMethod: "cash" | "jawwal_pay" | "palpay" | "bank_of_palestine" | "wallet" | "bank_transfer" | "card";
  transferFromAccount?: string;
  transferFromType?: "jawwal_pay" | "palpay" | "bank_of_palestine";
  transferToAccount?: string;
  transferToType?: "jawwal_pay" | "palpay" | "bank_of_palestine";
  referenceNo?: string;
};

export type OfflineWorkPayload = SubscriberCreateDraft | SubscriberUpdateDraft | InvoiceIssueDraft | PaymentDraft;

export type QueuedOfflineWork = {
  id: string;
  clientOperationId: string;
  userId: number;
  siteId: number;
  kind: OfflineWorkKind;
  payload: OfflineWorkPayload;
  createdAt: number;
  updatedAt: number;
  status: OfflineWorkStatus;
  error?: string;
  appliedEntityId?: number;
  appliedLabel?: string;
};

const databaseName = "powerhub-offline-workspace";
const storeName = "operations";

export class OfflineWorkQueueError extends Error {}

export function assertOfflineWorkQueueAvailable() {
  if (typeof indexedDB === "undefined") throw new OfflineWorkQueueError("لا يدعم هذا المتصفح حفظ المسودات دون اتصال.");
}

export function createOfflineWork(input: Omit<QueuedOfflineWork, "id" | "clientOperationId" | "createdAt" | "updatedAt" | "status">): QueuedOfflineWork {
  const id = crypto.randomUUID();
  const now = Date.now();
  return { ...input, id, clientOperationId: id, createdAt: now, updatedAt: now, status: "pending" };
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    assertOfflineWorkQueueAvailable();
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new OfflineWorkQueueError("تعذر فتح طابور المسودات المحلي."));
  });
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new OfflineWorkQueueError("تعذر تحديث طابور المسودات."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new OfflineWorkQueueError("تعذر حفظ المسودة المحلية.")); };
  });
}

export async function listOfflineWork(options: { userId: number; siteId?: number }) {
  const records = await transact<QueuedOfflineWork[]>("readonly", (store) => store.getAll());
  return records.filter((record) => record.userId === options.userId && (options.siteId === undefined || record.siteId === options.siteId)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function enqueueOfflineWork(input: Omit<QueuedOfflineWork, "id" | "clientOperationId" | "createdAt" | "updatedAt" | "status">) {
  const record = createOfflineWork(input);
  await transact("readwrite", (store) => store.put(record));
  return record;
}

export async function updateOfflineWork(id: string, patch: Partial<Pick<QueuedOfflineWork, "status" | "error" | "appliedEntityId" | "appliedLabel">>) {
  const existing = await transact<QueuedOfflineWork | undefined>("readonly", (store) => store.get(id));
  if (!existing) return;
  await transact("readwrite", (store) => store.put({ ...existing, ...patch, updatedAt: Date.now() }));
}

export async function removeOfflineWork(id: string) {
  await transact("readwrite", (store) => store.delete(id));
}
