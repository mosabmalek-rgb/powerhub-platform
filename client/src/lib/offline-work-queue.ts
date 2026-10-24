import { ensureLegacyFieldReadingsMigrated, openOfflineWorkspaceDatabase } from "./offline-workspace-db";
import { OfflineNumberRangeError, selectNextAvailableOfflineNumber, type OfflineNumberClaim, type OfflineNumberGrant, type OfflineNumberScope } from "./offline-number-ranges";
import type { SyncMetadataRecord } from "./offline-sync-metadata";
export type OfflineWorkKind =
  | "subscriber_create"
  | "subscriber_update"
  | "generator_create"
  | "generator_update"
  | "invoice_issue"
  | "payment_create"
  | "payment_documentation_submit"
  | "payment_documentation_approve"
  | "reading_create";

export type OfflineWorkStatus = "pending" | "conflict" | "failed" | "applied";

export type SubscriberOfflineNumberClaim = {
  grantId: string;
  deviceId: string;
  numberValue: string;
  partitionKey: "global";
  formattedNumber: string;
};

export type SubscriberCreateDraft = {
  fullName: string;
  phone: string;
  address?: string;
  subscriptionType: "residential" | "commercial" | "institution" | "mosque";
  offlineNumberClaim?: SubscriberOfflineNumberClaim;
};

export type SubscriberUpdateDraft = SubscriberCreateDraft & {
  subscriberId: number;
  serviceStatus: "active" | "suspended" | "disconnected";
  expectedUpdatedAt: string;
};

export type GeneratorCreateDraft = {
  code: string;
  name: string;
  serialNumber?: string;
  ratedCapacityKw?: string;
  fuelType: "diesel" | "gasoline" | "gas" | "other";
};

export type GeneratorUpdateDraft = {
  generatorId: number;
  name: string;
  ratedCapacityKw?: string;
  fuelLevelLiters: string;
  operatingHours: string;
  status: "active" | "maintenance" | "stopped" | "offline";
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
  paymentMethod:
    | "cash"
    | "jawwal_pay"
    | "palpay"
    | "bank_of_palestine"
    | "wallet"
    | "bank_transfer"
    | "card";
  companyAccountId: number;
  transferFromAccount?: string;
  transferFromType?: "jawwal_pay" | "palpay" | "bank_of_palestine";
  referenceNo?: string;
  receiptImageData?: string;
  receiptImageMime?: "image/jpeg" | "image/png" | "image/webp";
};

export type InvoiceOfflineNumberClaim = {
  grantId: string;
  deviceId: string;
  numberValue: string;
  partitionKey: string;
  formattedNumber: string;
};

export type ReadingCreateDraft = {
  subscriberId: number;
  readingValue: string;
  readingAt: string;
  captureMethod: "manual" | "photo" | "smart_meter";
  imageData?: string;
  imageMime?: "image/jpeg" | "image/png" | "image/webp";
  notes?: string;
  isReadingReset?: boolean;
  overrideSameDay?: boolean;
  fieldVerified?: boolean;
  offlineInvoiceNumberClaim?: InvoiceOfflineNumberClaim;
};

export type PaymentDocumentationInvoiceSnapshot = {
  id: number; invoiceNo: string; billingPeriod?: string | null;
  previousReading: number | null; currentReading: number | null;
  consumptionKwh: number; pricePerKwh: number; consumptionValue: number | null;
  invoiceTotal: number; invoiceBalance: number; status: string;
};
export type PaymentDocumentationSubscriberSnapshot = {
  id: number; fullName: string; subscriberNo: string; phone: string; whatsappNumber?: string | null;
  invoices: PaymentDocumentationInvoiceSnapshot[];
};
export type PaymentDocumentationAccountSnapshot = { id: number; name: string; accountType: string; phoneNumber?: string | null };
export type PaymentDocumentationDraft = {
  subscriberId: number; invoiceId: number; destinationAccountId: number; paymentAmount: number;
  paymentMethod: PaymentDraft["paymentMethod"]; senderPhone?: string; referenceNo?: string;
  receiptImageData?: string; receiptImageMime?: "image/jpeg" | "image/png" | "image/webp";
  snapshot: { capturedAt: string; subscriber: PaymentDocumentationSubscriberSnapshot; invoice: PaymentDocumentationInvoiceSnapshot; account: PaymentDocumentationAccountSnapshot };
};

export type PaymentDocumentationApprovalDraft = {
  requestId: number;
  capturedAt: string;
  requestSnapshot: {
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
};

export type OfflineWorkPayload =
  | SubscriberCreateDraft
  | SubscriberUpdateDraft
  | GeneratorCreateDraft
  | GeneratorUpdateDraft
  | InvoiceIssueDraft
  | PaymentDraft
  | PaymentDocumentationDraft
  | PaymentDocumentationApprovalDraft
  | ReadingCreateDraft;

export type QueuedOfflineWork = {
  id: string;
  clientOperationId: string;
  userId: number;
  siteId: number;
  tenantId?: number;
  kind: OfflineWorkKind;
  payload: OfflineWorkPayload;
  createdAt: number;
  updatedAt: number;
  status: OfflineWorkStatus;
  error?: string;
  appliedEntityId?: number;
  appliedLabel?: string;
};
/**
 * Validate that persisted synchronization state belongs to this exact Outbox
 * operation. Legacy metadata without tenantId remains compatible only when all
 * stable identity fields match; an explicit tenant mismatch always fails closed.
 */
export function isSyncMetadataCompatibleWithWorkItem(
  item: Pick<QueuedOfflineWork, "clientOperationId" | "userId" | "tenantId" | "siteId" | "kind">,
  metadata?: SyncMetadataRecord,
): metadata is SyncMetadataRecord {
  return Boolean(
    metadata &&
    metadata.operationId === item.clientOperationId &&
    metadata.userId === item.userId &&
    metadata.siteId === item.siteId &&
    metadata.kind === item.kind &&
    (metadata.tenantId === undefined || metadata.tenantId === item.tenantId)
  );
}

/** Manual retry is allowed only for a failed row with scope-matched transient metadata. */
export function canRequeueFailedOfflineWork(item: QueuedOfflineWork, metadata?: SyncMetadataRecord): boolean {
  return item.status === "failed" &&
    isSyncMetadataCompatibleWithWorkItem(item, metadata) &&
    metadata.outcome === "retryable";
}



const databaseName = "powerhub-offline-workspace";
const storeName = "operations";
const grantsStoreName = "grants";
const claimsStoreName = "claims";
const syncMetadataStoreName = "syncMetadata";

export class OfflineWorkQueueError extends Error {}

export function assertOfflineWorkQueueAvailable() {
  if (typeof indexedDB === "undefined") {
    throw new OfflineWorkQueueError("لا يدعم هذا المتصفح حفظ المسودات دون اتصال.");
  }
}

export function createOfflineWork(
  input: Omit<QueuedOfflineWork, "id" | "clientOperationId" | "createdAt" | "updatedAt" | "status"> & { clientOperationId?: string },
): QueuedOfflineWork {
  const id = input.clientOperationId ?? crypto.randomUUID();
  const now = Date.now();
  return {
    ...input,
    id,
    clientOperationId: input.clientOperationId ?? id,
    createdAt: now,
    updatedAt: now,
    status: "pending",
  };
}

/** Initial sync state must be committed with its matching Outbox operation. */
export function createInitialSyncMetadataRecord(item: QueuedOfflineWork): SyncMetadataRecord {
  return {
    operationId: item.clientOperationId, userId: item.userId,
    ...(item.tenantId !== undefined ? { tenantId: item.tenantId } : {}),
    siteId: item.siteId, kind: item.kind, dependsOn: [], attempts: 0,
    nextAttemptAt: item.createdAt, outcome: "pending", updatedAt: item.createdAt,
  };
}

function openDatabase() {
  assertOfflineWorkQueueAvailable();
  return openOfflineWorkspaceDatabase().then(async (db) => {
    try {
      await ensureLegacyFieldReadingsMigrated(db);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new OfflineWorkQueueError("تعذر تحديث طابور المسودات."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new OfflineWorkQueueError("تعذر حفظ المسودة المحلية."));
    };
  });
}

export async function listOfflineWork(options: { userId: number; siteId?: number }) {
  const records = await transact<QueuedOfflineWork[]>("readonly", (store) => store.getAll());
  return records
    .filter(
      (record) =>
        record.userId === options.userId &&
        (options.siteId === undefined || record.siteId === options.siteId),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function enqueueOfflineWork(
  input: Omit<QueuedOfflineWork, "id" | "clientOperationId" | "createdAt" | "updatedAt" | "status"> & { clientOperationId?: string },
) {
  const record = createOfflineWork(input);
  const database = await openDatabase();
  return new Promise<QueuedOfflineWork>((resolve, reject) => {
    const transaction = database.transaction([storeName, syncMetadataStoreName], "readwrite");
    // A repeated operation ID must fail the whole transaction, never overwrite
    // a prior draft or its terminal result with a new pending state.
    transaction.objectStore(storeName).add(record);
    transaction.objectStore(syncMetadataStoreName).add(createInitialSyncMetadataRecord(record));
    transaction.oncomplete = () => { database.close(); resolve(record); };
    transaction.onerror = () => { const error = transaction.error; database.close(); reject(error ?? new OfflineWorkQueueError("تعذر حفظ المسودة وحالة مزامنتها معًا.")); };
    transaction.onabort = () => { const error = transaction.error; database.close(); reject(error ?? new OfflineWorkQueueError("أُلغيت معاملة حفظ المسودة وحالة مزامنتها.")); };
  });
}

export async function enqueueOfflineSubscriberCreateWithNumber(input: {
  scope: OfflineNumberScope;
  payload: Omit<SubscriberCreateDraft, "offlineNumberClaim">;
}): Promise<{ item: QueuedOfflineWork; formattedNumber: string }> {
  const { scope } = input;
  const now = Date.now();
  const clientOperationId = crypto.randomUUID();
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName, grantsStoreName, claimsStoreName, syncMetadataStoreName], "readwrite");
    const operations = transaction.objectStore(storeName);
    const grantsStore = transaction.objectStore(grantsStoreName);
    const claimsStore = transaction.objectStore(claimsStoreName);
    const syncMetadata = transaction.objectStore(syncMetadataStoreName);
    const grantsRequest = grantsStore.getAll();
    const claimsRequest = claimsStore.getAll();
    let grants: OfflineNumberGrant[] | undefined;
    let claims: OfflineNumberClaim[] | undefined;
    let output: { item: QueuedOfflineWork; formattedNumber: string } | undefined;
    let failure: unknown;
    let evaluated = false;
    const evaluate = () => {
      if (grants === undefined || claims === undefined || evaluated) return;
      evaluated = true;
      try {
        const eligible = grants.filter((grant) =>
          grant.userId === scope.userId && grant.tenantId === scope.tenantId &&
          grant.siteId === scope.siteId && grant.deviceId === scope.deviceId &&
          grant.numberKind === "subscriber" && grant.partitionKey === "global" &&
          !grant.revokedAt && grant.expiresAt > now &&
          grant.reservedValues.some((value) => !claims!.some((claim) => claim.grantId === grant.id && claim.numberValue === value)),
        ).sort((left, right) => left.expiresAt - right.expiresAt || left.issuedAt - right.issuedAt);
        let selected: { grant: OfflineNumberGrant; numberValue: string; formattedNumber: string } | undefined;
        for (const grant of eligible) {
          const decision = selectNextAvailableOfflineNumber({
            grant, claims, scope, clientOperationId, entityType: "subscriber", now,
          });
          if (!decision.replayed && decision.numberValue) {
            selected = { grant, numberValue: decision.numberValue, formattedNumber: decision.formattedNumber };
            break;
          }
        }
        if (!selected) {
          throw new OfflineNumberRangeError(
            "لا توجد أرقام مشتركين محجوزة لهذا الفرع والجهاز. اتصل بالإنترنت لحجز نطاق قبل إنشاء المسودة دون اتصال.",
            "NO_RESERVED_OFFLINE_NUMBER",
          );
        }
        const claim: OfflineNumberClaim = {
          id: crypto.randomUUID(), grantId: selected.grant.id, ...scope,
          numberKind: "subscriber", partitionKey: "global", numberValue: selected.numberValue,
          clientOperationId, entityType: "subscriber", createdAt: now,
        };
        const item = createOfflineWork({
          userId: scope.userId, tenantId: scope.tenantId, siteId: scope.siteId,
          kind: "subscriber_create", clientOperationId,
          payload: {
            ...input.payload,
            offlineNumberClaim: {
              grantId: selected.grant.id, deviceId: scope.deviceId, numberValue: selected.numberValue,
              partitionKey: "global", formattedNumber: selected.formattedNumber,
            },
          },
        });
        // Persist the claim and its Outbox operation in one IDB transaction.
        // Either both survive a reload/crash, or neither does.
        claimsStore.add(claim);
        operations.add(item);
        syncMetadata.put(createInitialSyncMetadataRecord(item));
        output = { item, formattedNumber: selected.formattedNumber };
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    grantsRequest.onsuccess = () => { grants = grantsRequest.result as OfflineNumberGrant[]; evaluate(); };
    claimsRequest.onsuccess = () => { claims = claimsRequest.result as OfflineNumberClaim[]; evaluate(); };
    grantsRequest.onerror = () => { failure = grantsRequest.error; transaction.abort(); };
    claimsRequest.onerror = () => { failure = claimsRequest.error; transaction.abort(); };
    transaction.oncomplete = () => {
      database.close();
      if (output) resolve(output);
      else reject(new OfflineNumberRangeError("لم ينتج حجز الرقم والمسودة نتيجة مكتملة.", "OFFLINE_SUBSCRIBER_ENQUEUE_EMPTY"));
    };
    transaction.onerror = () => { database.close(); reject(failure ?? transaction.error ?? new OfflineWorkQueueError("تعذر حفظ المطالبة والمسودة محليًا.")); };
    transaction.onabort = () => { database.close(); reject(failure ?? transaction.error ?? new OfflineWorkQueueError("أُلغي حفظ المطالبة والمسودة محليًا.")); };
  });
}
export async function enqueueOfflineReadingWithInvoiceNumber(input: {
  scope: OfflineNumberScope;
  partitionKey: string;
  clientOperationId: string;
  payload: Omit<ReadingCreateDraft, "offlineInvoiceNumberClaim">;
}): Promise<{ item: QueuedOfflineWork; formattedInvoiceNumber: string }> {
  const { scope, partitionKey, clientOperationId } = input;
  const now = Date.now();
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([storeName, grantsStoreName, claimsStoreName, syncMetadataStoreName], "readwrite");
    const operations = transaction.objectStore(storeName);
    const grantsStore = transaction.objectStore(grantsStoreName);
    const claimsStore = transaction.objectStore(claimsStoreName);
    const syncMetadata = transaction.objectStore(syncMetadataStoreName);
    const grantsRequest = grantsStore.getAll();
    const claimsRequest = claimsStore.getAll();
    let grants: OfflineNumberGrant[] | undefined;
    let claims: OfflineNumberClaim[] | undefined;
    let output: { item: QueuedOfflineWork; formattedInvoiceNumber: string } | undefined;
    let failure: unknown;
    let evaluated = false;
    const evaluate = () => {
      if (grants === undefined || claims === undefined || evaluated) return;
      evaluated = true;
      try {
        const eligible = grants.filter((grant) =>
          grant.userId === scope.userId && grant.tenantId === scope.tenantId &&
          grant.siteId === scope.siteId && grant.deviceId === scope.deviceId &&
          grant.numberKind === "invoice" && grant.partitionKey === partitionKey &&
          !grant.revokedAt && grant.expiresAt > now &&
          grant.reservedValues.some((value) => !claims!.some((claim) => claim.grantId === grant.id && claim.numberValue === value)),
        ).sort((left, right) => left.expiresAt - right.expiresAt || left.issuedAt - right.issuedAt);
        let selected: { grant: OfflineNumberGrant; numberValue: string; formattedNumber: string } | undefined;
        for (const grant of eligible) {
          const decision = selectNextAvailableOfflineNumber({ grant, claims, scope, clientOperationId, entityType: "invoice", now });
          if (!decision.replayed && decision.numberValue) { selected = { grant, numberValue: decision.numberValue, formattedNumber: decision.formattedNumber }; break; }
        }
        if (!selected) throw new OfflineNumberRangeError("لا توجد أرقام فواتير محجوزة لهذه السنة على هذا الجهاز. ستُسند الفاتورة من الخادم عند المزامنة.", "NO_RESERVED_OFFLINE_INVOICE_NUMBER");
        const claim: OfflineNumberClaim = {
          id: crypto.randomUUID(), grantId: selected.grant.id, ...scope, numberKind: "invoice",
          partitionKey, numberValue: selected.numberValue, clientOperationId, entityType: "invoice", createdAt: now,
        };
        const item = createOfflineWork({
          userId: scope.userId, tenantId: scope.tenantId, siteId: scope.siteId, kind: "reading_create", clientOperationId,
          payload: { ...input.payload, offlineInvoiceNumberClaim: { grantId: selected.grant.id, deviceId: scope.deviceId, numberValue: selected.numberValue, partitionKey, formattedNumber: selected.formattedNumber } },
        });
        // The invoice claim and reading operation commit or abort together.
        claimsStore.add(claim);
        operations.add(item);
        syncMetadata.put(createInitialSyncMetadataRecord(item));
        output = { item, formattedInvoiceNumber: selected.formattedNumber };
      } catch (error) { failure = error; transaction.abort(); }
    };
    grantsRequest.onsuccess = () => { grants = grantsRequest.result as OfflineNumberGrant[]; evaluate(); };
    claimsRequest.onsuccess = () => { claims = claimsRequest.result as OfflineNumberClaim[]; evaluate(); };
    grantsRequest.onerror = () => { failure = grantsRequest.error; transaction.abort(); };
    claimsRequest.onerror = () => { failure = claimsRequest.error; transaction.abort(); };
    transaction.oncomplete = () => { database.close(); if (output) resolve(output); else reject(new OfflineNumberRangeError("لم ينتج حجز رقم الفاتورة والمسودة نتيجة مكتملة.", "OFFLINE_INVOICE_ENQUEUE_EMPTY")); };
    transaction.onerror = () => { database.close(); reject(failure ?? transaction.error ?? new OfflineWorkQueueError("تعذر حفظ مطالبة الفاتورة والمسودة محليًا.")); };
    transaction.onabort = () => { database.close(); reject(failure ?? transaction.error ?? new OfflineWorkQueueError("أُلغي حفظ مطالبة الفاتورة والمسودة محليًا.")); };
  });
}
export async function getOfflineWork(id: string): Promise<QueuedOfflineWork | undefined> {
  return transact<QueuedOfflineWork | undefined>("readonly", (store) => store.get(id));
}

export async function updateOfflineWork(
  id: string,
  patch: Partial<
    Pick<QueuedOfflineWork, "status" | "error" | "appliedEntityId" | "appliedLabel" | "payload">
  >,
) {
  const existing = await transact<QueuedOfflineWork | undefined>("readonly", (store) => store.get(id));
  if (!existing) return;
  await transact("readwrite", (store) =>
    store.put({ ...existing, ...patch, updatedAt: Date.now() }),
  );
}

/**
 * Atomically moves a failed Outbox row and its matching transient metadata back
 * to pending. Re-check the current database state inside the write transaction:
 * the UI's earlier list may be stale, and a crash must not leave half a retry.
 */
export async function requeueOfflineWorkForManualRetry(input: {
  id: string;
  clientOperationId: string;
  userId: number;
  siteId: number;
  now?: number;
}): Promise<boolean> {
  if (!input.id || !input.clientOperationId ||
      !Number.isSafeInteger(input.userId) || input.userId < 1 ||
      !Number.isSafeInteger(input.siteId) || input.siteId < 1) {
    throw new OfflineWorkQueueError("نطاق إعادة محاولة المسودة غير صالح.");
  }
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) throw new OfflineWorkQueueError("وقت إعادة محاولة المسودة غير صالح.");
  const database = await openDatabase();
  return new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction([storeName, syncMetadataStoreName], "readwrite");
    const operations = transaction.objectStore(storeName);
    const metadataStore = transaction.objectStore(syncMetadataStoreName);
    const operationRequest = operations.get(input.id);
    const metadataRequest = metadataStore.get(input.clientOperationId);
    let operation: QueuedOfflineWork | undefined;
    let metadata: SyncMetadataRecord | undefined;
    let operationReady = false;
    let metadataReady = false;
    let evaluated = false;
    let requeued = false;

    const evaluate = () => {
      if (!operationReady || !metadataReady || evaluated) return;
      evaluated = true;
      if (!operation || !metadata ||
          operation.id !== input.id ||
          operation.clientOperationId !== input.clientOperationId ||
          operation.userId !== input.userId ||
          operation.siteId !== input.siteId ||
          !canRequeueFailedOfflineWork(operation, metadata)) return;

      const { lastError: _lastError, ...retryMetadata } = metadata;
      void _lastError;
      operations.put({ ...operation, status: "pending", error: undefined, updatedAt: now });
      metadataStore.put({
        ...retryMetadata,
        attempts: 0,
        nextAttemptAt: now,
        outcome: "pending",
        updatedAt: now,
      });
      requeued = true;
    };

    operationRequest.onsuccess = () => { operation = operationRequest.result as QueuedOfflineWork | undefined; operationReady = true; evaluate(); };
    metadataRequest.onsuccess = () => { metadata = metadataRequest.result as SyncMetadataRecord | undefined; metadataReady = true; evaluate(); };
    operationRequest.onerror = () => { try { transaction.abort(); } catch {} };
    metadataRequest.onerror = () => { try { transaction.abort(); } catch {} };
    transaction.oncomplete = () => { database.close(); resolve(requeued); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new OfflineWorkQueueError("تعذر تحديث المسودة وبيانات إعادة المحاولة معًا.")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new OfflineWorkQueueError("أُلغيت معاملة إعادة محاولة المسودة.")); };
  });
}

export async function removeOfflineWork(id: string) {
  await transact("readwrite", (store) => store.delete(id));
}