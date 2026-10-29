import { ensureLegacyFieldReadingsMigrated, openOfflineWorkspaceDatabase } from "./offline-workspace-db";
import { OfflineNumberRangeError, selectNextAvailableOfflineNumber, type OfflineNumberClaim, type OfflineNumberGrant, type OfflineNumberScope } from "./offline-number-ranges";
import type { SyncMetadataRecord } from "./offline-sync-metadata";
import { isManualSyncRecoveryRequired } from "./offline-sync-engine";
const OFFLINE_WORK_QUEUE_CHANGED_EVENT = "powerhub:offline-work-queue-changed";
const OFFLINE_WORK_QUEUE_CHANGED_CHANNEL = "powerhub-offline-work-queue";
const OFFLINE_WORK_QUEUE_SOURCE_ID = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

export type OfflineWorkQueueScope = { userId: number; siteId: number };

/** Notify the current tab and sibling tabs after a durable Outbox change. */
export function notifyOfflineWorkQueueChanged(scope: OfflineWorkQueueScope) {
  const detail = { ...scope, sourceId: OFFLINE_WORK_QUEUE_SOURCE_ID };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(OFFLINE_WORK_QUEUE_CHANGED_EVENT, { detail }));
  }
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(OFFLINE_WORK_QUEUE_CHANGED_CHANNEL);
      channel.postMessage(detail);
      channel.close();
    } catch {
      // Same-tab events remain available if BroadcastChannel is unavailable.
    }
  }
}

/** Subscribe to scoped Outbox changes from this tab and sibling browser tabs. */
export function subscribeOfflineWorkQueueChanges(scope: OfflineWorkQueueScope, onChanged: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const matches = (value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const detail = value as { userId?: unknown; siteId?: unknown; sourceId?: unknown };
    return Number(detail.userId) === scope.userId && Number(detail.siteId) === scope.siteId;
  };
  const onWindowChange = (event: Event) => {
    if (matches((event as CustomEvent).detail)) onChanged();
  };
  window.addEventListener(OFFLINE_WORK_QUEUE_CHANGED_EVENT, onWindowChange);
  let channel: BroadcastChannel | undefined;
  let onMessage: ((event: MessageEvent) => void) | undefined;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(OFFLINE_WORK_QUEUE_CHANGED_CHANNEL);
      onMessage = (event: MessageEvent) => {
        if (!matches(event.data)) return;
        if ((event.data as { sourceId?: unknown }).sourceId === OFFLINE_WORK_QUEUE_SOURCE_ID) return;
        onChanged();
      };
      channel.addEventListener("message", onMessage);
    } catch {
      channel?.close();
      channel = undefined;
    }
  }
  return () => {
    window.removeEventListener(OFFLINE_WORK_QUEUE_CHANGED_EVENT, onWindowChange);
    if (channel && onMessage) channel.removeEventListener("message", onMessage);
    channel?.close();
  };
}

export type OfflineWorkKind =
  | "subscriber_create"
  | "subscriber_update"
  | "generator_create"
  | "generator_update"
  | "fuel_fill"
  | "invoice_issue"
  | "payment_create"
  | "payment_documentation_submit"
  | "payment_documentation_approve"
  | "reading_create"
  | "employee_create"
  | "employee_update"
  | "attendance_upsert"
  | "payroll_draft"
  | "employee_advance_issue"
  | "employee_advance_repayment";

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
  openingReading?: string;
  openingReadingAt?: string;
  openingReadingApproved?: boolean;
  openingReadingImageData?: string;
  openingReadingImageMime?: "image/jpeg" | "image/png" | "image/webp";
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

export type FuelFillDraft = {
  generatorId: number;
  fuelItemId: number;
  sourceWarehouseId: number;
  destinationWarehouseId: number;
  litres: number;
  occurredAt: string;
  levelBeforeLiters?: number | null;
  levelAfterLiters?: number | null;
  operatingHours?: number | null;
  referenceNo?: string;
  notes?: string;
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
  requestSnapshot?: {
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

export type HrEmployeeCreateDraft = {
  localEmployeeId: number;
  fullName: string;
  identityNo?: string | null;
  phone?: string | null;
  jobTitle: "accountant" | "collector" | "technician" | "worker" | "supervisor" | "other";
  employmentStatus: "active" | "suspended" | "ended";
  contractType: "daily" | "monthly" | "collection_percentage";
  baseWage: number;
  hireDate?: string | null;
  notes?: string | null;
  linkedUserId?: number | null;
};
export type HrEmployeeUpdateDraft = {
  employeeId: number;
  expectedVersion: number | null;
  patch: Partial<Pick<HrEmployeeCreateDraft, "fullName" | "identityNo" | "phone" | "jobTitle" | "employmentStatus" | "contractType" | "baseWage" | "hireDate" | "notes">>;
};
export type HrAttendanceUpsertDraft = {
  employeeId: number;
  workDate: string;
  expectedVersion: number | null;
  regularHours: number;
  overtimeHours: number;
  absentDays: number;
  notes?: string | null;
  localAttendanceId?: number;
};
export type HrPayrollDraftPayload = {
  period: string;
  items: Array<{ employeeId: number; extraAmount: number; advanceDeduction: number; otherDeduction: number; notes?: string }>;
};
export type HrEmployeeAdvanceIssueDraft = {
  employeeId: number;
  advanceKind: "salary_advance" | "employee_loan";
  amount: number;
  monthlyDeduction?: number;
  accountId: number;
  paymentDate: string;
  reason: string;
  localAdjustmentId?: number;
};
export type HrEmployeeAdvanceRepaymentDraft = {
  adjustmentId: number;
  accountId: number;
  amount: number;
  paymentDate: string;
  referenceNo?: string;
  notes?: string;
  localRepaymentId?: number;
};

export type OfflineWorkPayload =
  | SubscriberCreateDraft
  | SubscriberUpdateDraft
  | GeneratorCreateDraft
  | GeneratorUpdateDraft
  | FuelFillDraft
  | InvoiceIssueDraft
  | PaymentDraft
  | PaymentDocumentationDraft
  | PaymentDocumentationApprovalDraft
  | ReadingCreateDraft
  | HrEmployeeCreateDraft
  | HrEmployeeUpdateDraft
  | HrAttendanceUpsertDraft
  | HrPayrollDraftPayload
  | HrEmployeeAdvanceIssueDraft
  | HrEmployeeAdvanceRepaymentDraft;

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
  appliedVersionNo?: number;
};

 /**
  * Generates a negative local-only reference with 52 random bits.
  * Do not use wall-clock milliseconds for entity references: rapid submissions
  * can collide and cause dependent Outbox operations to bind to the wrong row.
  */
export function createOfflineLocalEntityId(): number {
  const magnitude = Number.parseInt(crypto.randomUUID().replace(/-/g, "").slice(0, 13), 16);
  return -Math.max(1, magnitude);
}

/** Refuse a second payroll draft when a prior same-period operation is still
 * pending, ambiguous, conflicted, missing metadata, or already applied locally.
 * A definitively rejected, scope-matched operation is the only failed row that
 * may be replaced by a corrected request using a new operation key.
 */
export function blocksDuplicateOfflinePayrollPeriod(
  item: QueuedOfflineWork,
  scope: { userId: number; siteId: number; period: string },
  metadata?: SyncMetadataRecord,
): boolean {
  if (item.userId !== scope.userId || item.siteId !== scope.siteId || item.kind !== "payroll_draft") return false;
  if ((item.payload as HrPayrollDraftPayload).period !== scope.period) return false;
  const definitivelyRejected = item.status === "failed" &&
    isSyncMetadataCompatibleWithWorkItem(item, metadata) &&
    metadata.outcome === "rejected";
  return !definitivelyRejected;
}
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

/**
 * Recover a result-unknown operation only when automatic retries are exhausted.
 * Keep the original operation ID: the server's idempotency contract determines
 * whether the previous request committed and must return its original result.
 */
export function canRequeueOfflineWorkForManualRecovery(
  item: QueuedOfflineWork,
  metadata?: SyncMetadataRecord,
): boolean {
  if (!isSyncMetadataCompatibleWithWorkItem(item, metadata)) return false;
  if (item.status === "failed" && metadata.outcome === "retryable") return true;
  return (item.status === "pending" || item.status === "failed") &&
    isManualSyncRecoveryRequired(metadata);
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
export function createInitialSyncMetadataRecord(item: QueuedOfflineWork, dependsOn: readonly string[] = []): SyncMetadataRecord {
  return {
    operationId: item.clientOperationId, userId: item.userId,
    ...(item.tenantId !== undefined ? { tenantId: item.tenantId } : {}),
    siteId: item.siteId, kind: item.kind, dependsOn: [...new Set(dependsOn)].filter((id) => id !== item.clientOperationId), attempts: 0,
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

type OfflineWorkEnqueueInput =
  Omit<QueuedOfflineWork, "id" | "clientOperationId" | "createdAt" | "updatedAt" | "status"> &
  { clientOperationId?: string; dependsOn?: readonly string[] };

export async function enqueueOfflineWork(input: OfflineWorkEnqueueInput) {
  const { dependsOn = [], ...workInput } = input;
  const record = createOfflineWork(workInput);
  const database = await openDatabase();
  return new Promise<QueuedOfflineWork>((resolve, reject) => {
    const transaction = database.transaction([storeName, syncMetadataStoreName], "readwrite");
    transaction.objectStore(storeName).add(record);
    transaction.objectStore(syncMetadataStoreName).add(createInitialSyncMetadataRecord(record, dependsOn));
    transaction.oncomplete = () => { database.close(); resolve(record); };
    transaction.onerror = () => { const error = transaction.error; database.close(); reject(error ?? new OfflineWorkQueueError("تعذر حفظ المسودة وحالة مزامنتها معًا.")); };
    transaction.onabort = () => { const error = transaction.error; database.close(); reject(error ?? new OfflineWorkQueueError("أُلغيت معاملة حفظ المسودة وحالة مزامنتها.")); };
  });
}

/** HR queue writes use the same operation store and dependency metadata as every other outbox item. */
export async function enqueueOfflineHrWork(input: OfflineWorkEnqueueInput) {
  const { dependsOn = [], ...workInput } = input;
  if (!["employee_create","employee_update","attendance_upsert","payroll_draft","employee_advance_issue","employee_advance_repayment"].includes(workInput.kind)) {
    throw new OfflineWorkQueueError("نوع العملية ليس عملية موارد بشرية قابلة للإضافة إلى الطابور.");
  }
  const record = createOfflineWork(workInput);
  const db = await openDatabase();
  return new Promise<QueuedOfflineWork>((resolve, reject) => {
    const tx = db.transaction([storeName, syncMetadataStoreName], "readwrite");
    const operationsStore = tx.objectStore(storeName);
    const metadataStore = tx.objectStore(syncMetadataStoreName);
    const operationsRequest = operationsStore.getAll();
    const metadataRequest = metadataStore.getAll();
    let operationRows: QueuedOfflineWork[] | undefined;
    let metadataRows: SyncMetadataRecord[] | undefined;
    let output: QueuedOfflineWork | undefined;
    let failure: unknown;
    let evaluated = false;
    const evaluate = () => {
      if (evaluated || !operationRows || !metadataRows) return;
      evaluated = true;
      try {
        const eligibleToCoalesce = (item: QueuedOfflineWork) => {
          const metadata = metadataRows!.find((entry) => entry.operationId === item.clientOperationId);
          return item.userId === record.userId && item.siteId === record.siteId &&
            item.status === "pending" && metadata?.outcome === "pending" && metadata.attempts === 0;
        };
        const incoming = record.payload as Record<string, any>;
        if (record.kind === "employee_update") {
          const localCreate = operationRows.find((item) => item.kind === "employee_create" &&
            item.userId === record.userId && item.siteId === record.siteId &&
            (item.payload as HrEmployeeCreateDraft).localEmployeeId === incoming.employeeId && eligibleToCoalesce(item));
          if (localCreate) {
            const createPayload = localCreate.payload as HrEmployeeCreateDraft;
            const patch = incoming.patch as HrEmployeeUpdateDraft["patch"];
            const fieldMap: Record<string, keyof HrEmployeeCreateDraft> = {
              fullName: "fullName", identityNo: "identityNo", phone: "phone", jobTitle: "jobTitle",
              employmentStatus: "employmentStatus", contractType: "contractType", baseWage: "baseWage",
              hireDate: "hireDate", notes: "notes",
            };
            for (const [field, value] of Object.entries(patch)) {
              const target = fieldMap[field];
              if (target) (createPayload as any)[target] = value;
            }
            localCreate.payload = createPayload;
            localCreate.updatedAt = Date.now();
            operationsStore.put(localCreate);
            output = localCreate;
            return;
          }
        }
        const sameKey = (item: QueuedOfflineWork) => {
          if (!eligibleToCoalesce(item) || item.kind !== record.kind) return false;
          const prior = item.payload as Record<string, any>;
          if (record.kind === "employee_update") return prior.employeeId === incoming.employeeId;
          if (record.kind === "attendance_upsert") return prior.employeeId === incoming.employeeId && prior.workDate === incoming.workDate;
          return false;
        };
        const existing = operationRows.find(sameKey);
        if (existing) {
          if (record.kind === "employee_update") {
            const prior = existing.payload as HrEmployeeUpdateDraft;
            const next = record.payload as HrEmployeeUpdateDraft;
            existing.payload = { ...prior, patch: { ...prior.patch, ...next.patch } };
          } else if (record.kind === "attendance_upsert") {
            const prior = existing.payload as HrAttendanceUpsertDraft;
            const next = record.payload as HrAttendanceUpsertDraft;
            existing.payload = { ...prior, regularHours: next.regularHours, overtimeHours: next.overtimeHours, absentDays: next.absentDays, notes: next.notes };
          }
          existing.updatedAt = Date.now();
          operationsStore.put(existing);
          output = existing;
          return;
        }
        if (record.kind === "payroll_draft") {
          const incomingPeriod = (record.payload as HrPayrollDraftPayload).period;
          const duplicate = operationRows.find((item) => {
            const metadata = metadataRows!.find((entry) => entry.operationId === item.clientOperationId);
            return blocksDuplicateOfflinePayrollPeriod(item, {
              userId: record.userId, siteId: record.siteId, period: incomingPeriod,
            }, metadata);
          });
          if (duplicate) throw new OfflineWorkQueueError("توجد عملية رواتب محفوظة لهذه الفترة؛ راجع نتيجتها قبل إنشاء مسودة أخرى.");
        }
        operationsStore.add(record);
        metadataStore.add(createInitialSyncMetadataRecord(record, dependsOn));
        output = record;
      } catch (error) {
        failure = error;
        try { tx.abort(); } catch {}
      }
    };
    operationsRequest.onsuccess = () => { operationRows = operationsRequest.result as QueuedOfflineWork[]; evaluate(); };
    metadataRequest.onsuccess = () => { metadataRows = metadataRequest.result as SyncMetadataRecord[]; evaluate(); };
    operationsRequest.onerror = () => { failure = operationsRequest.error; try { tx.abort(); } catch {} };
    metadataRequest.onerror = () => { failure = metadataRequest.error; try { tx.abort(); } catch {} };
    tx.oncomplete = () => {
      db.close();
      if (!output) {
        reject(new OfflineWorkQueueError("لم تنتج إضافة عملية الموارد البشرية نتيجة محفوظة."));
        return;
      }
      notifyOfflineWorkQueueChanged({ userId: record.userId, siteId: record.siteId });
      resolve(output);
    };
    tx.onerror = () => { const error = tx.error; db.close(); reject(failure ?? error ?? new OfflineWorkQueueError("تعذر حفظ عملية الموارد البشرية."));
    };
    tx.onabort = () => { const error = tx.error; db.close(); reject(failure ?? error ?? new OfflineWorkQueueError("أُلغيت إضافة عملية الموارد البشرية.")); };
  });
}

/** Resolve negative local employee IDs after their create command is acknowledged. */
export async function resolveOfflineEmployeeReferences(input: {
  userId: number; siteId: number; localEmployeeId: number; serverEmployeeId: number; serverVersion: number;
}) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => {
      for (const item of request.result as QueuedOfflineWork[]) {
        if (item.userId !== input.userId || item.siteId !== input.siteId || item.status === "applied") continue;
        const payload = item.payload as any;
        let changed = false;
        if ((item.kind === "employee_update" || item.kind === "attendance_upsert" || item.kind === "employee_advance_issue") &&
            payload.employeeId === input.localEmployeeId) {
          payload.employeeId = input.serverEmployeeId;
          if (item.kind === "employee_update") payload.expectedVersion = input.serverVersion;
          changed = true;
        } else if (item.kind === "payroll_draft" && Array.isArray(payload.items)) {
          payload.items = payload.items.map((entry: any) => {
            if (entry.employeeId !== input.localEmployeeId) return entry;
            changed = true;
            return { ...entry, employeeId: input.serverEmployeeId };
          });
        }
        if (changed) store.put({ ...item, payload, updatedAt: Date.now() });
      }
    };
    request.onerror = () => { try { tx.abort(); } catch {} };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { const error = tx.error; db.close(); reject(error ?? new OfflineWorkQueueError("تعذر ربط عمليات الموظف بمعرف الخادم.")); };
    tx.onabort = () => { const error = tx.error; db.close(); reject(error ?? new OfflineWorkQueueError("أُلغيت عملية ربط معرف الموظف.")); };
  });
}

/** Resolve a locally recorded advance after server confirmation, without replaying a repayment twice. */
export async function resolveOfflineAdjustmentReferences(input: {
  userId: number; siteId: number; localAdjustmentId: number; serverAdjustmentId: number;
}) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => {
      for (const item of request.result as QueuedOfflineWork[]) {
        if (item.userId !== input.userId || item.siteId !== input.siteId ||
            item.status === "applied" || item.kind !== "employee_advance_repayment") continue;
        const payload = item.payload as HrEmployeeAdvanceRepaymentDraft;
        if (payload.adjustmentId !== input.localAdjustmentId) continue;
        store.put({ ...item, payload: { ...payload, adjustmentId: input.serverAdjustmentId }, updatedAt: Date.now() });
      }
    };
    request.onerror = () => { try { tx.abort(); } catch {} };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { const error = tx.error; db.close(); reject(error ?? new OfflineWorkQueueError("تعذر ربط السداد بمعرف السلفة الخادمي.")); };
    tx.onabort = () => { const error = tx.error; db.close(); reject(error ?? new OfflineWorkQueueError("أُلغيت عملية ربط معرف السلفة.")); };
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
    Pick<QueuedOfflineWork, "status" | "error" | "appliedEntityId" | "appliedLabel" | "appliedVersionNo" | "payload">
  >,
): Promise<void> {
  // Read and write the same row in one readwrite transaction. A separate readonly
  // transaction can race an executor/retry worker and overwrite a newer terminal
  // status or payload with an older snapshot.
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.get(id);
    request.onsuccess = () => {
      const existing = request.result as QueuedOfflineWork | undefined;
      if (!existing) return;
      store.put({ ...existing, ...patch, updatedAt: Date.now() });
    };
    request.onerror = () => {
      try { transaction.abort(); } catch {}
    };
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => {
      const error = transaction.error;
      database.close();
      reject(error ?? new OfflineWorkQueueError("تعذر تحديث المسودة المحلية."));
    };
    transaction.onabort = () => {
      const error = transaction.error;
      database.close();
      reject(error ?? new OfflineWorkQueueError("أُلغي تحديث المسودة المحلية."));
    };
  });
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
          !canRequeueOfflineWorkForManualRecovery(operation, metadata)) return;

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