import type { Query, QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import { isOfflineCacheableQueryKey, isDeltaSyncBackedQueryKey, isOfflineDashboardSnapshotQueryKey, isOfflineDashboardRevisionQueryKey, isSafeFilteredOperationalSnapshot, isSafePurchaseDetailSnapshot, isSafeSupplierLedgerStatementSnapshot, isSafeSupplierPayablesAgingSnapshot } from "./offline-query-policy";
import { clearOperationalReportSnapshotsForUser } from "./offline-operational-report-cache";
export { isOfflineCacheableQueryKey, isDeltaSyncBackedQueryKey } from "./offline-query-policy";

const DATABASE_NAME = "powerhub-offline-cache";
const DATABASE_VERSION = 2;
const QUERY_STORE = "queries";
const AUTH_STORE = "auth-users";
export const OFFLINE_QUERY_CACHE_MAX_RECORDS_PER_USER = 200;
export const OFFLINE_QUERY_CACHE_MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const OFFLINE_DASHBOARD_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_EXPENSE_FILTER_OPTIONS_TTL_MS = 24 * 60 * 60 * 1000;
export const OFFLINE_SUPPLIER_FINANCIAL_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
let successfulWritesSincePrune = 0;
let pruneInFlight: Promise<void> | null = null;

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


// Unlike the best-effort cache helpers, Delta checkpoints must wait for the
// IndexedDB transaction's complete event. A request's onsuccess can fire before
// the transaction commits and therefore is not, by itself, proof of durability.
async function withCommittedStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let requestSucceeded = false;
    let requestResult!: T;
    let transaction: IDBTransaction | undefined;

    const closeDatabase = () => {
      try { database.close(); } catch { /* closing is best effort after settlement */ }
    };
    const fail = (reason: unknown, fallback: string) => {
      if (settled) return;
      settled = true;
      closeDatabase();
      reject(reason instanceof Error ? reason : new Error(fallback));
    };

    try {
      const tx = database.transaction(storeName, mode);
      transaction = tx;
      const request = action(tx.objectStore(storeName));
      request.onsuccess = () => {
        requestSucceeded = true;
        requestResult = request.result;
      };
      request.onerror = () => fail(request.error, "تعذر تنفيذ طلب التخزين المحلي الإلزامي.");
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        closeDatabase();
        if (!requestSucceeded) {
          reject(new Error("اكتملت معاملة التخزين دون نجاح طلب الحفظ المطلوب."));
          return;
        }
        resolve(requestResult);
      };
      tx.onerror = () => fail(tx.error, "فشلت معاملة التخزين المحلي الإلزامي.");
      tx.onabort = () => fail(tx.error, "أُلغيت معاملة التخزين المحلي الإلزامي.");
    } catch (error) {
      try { transaction?.abort(); } catch { /* transaction may not have started */ }
      fail(error, "تعذر بدء معاملة التخزين المحلي الإلزامي.");
    }
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
      const rawData = superjson.parse(record.serializedData);
      const data = sanitizeOfflineQueryData(queryKey, rawData);
      const safeSerializedData = superjson.stringify(data);
      if (safeSerializedData !== record.serializedData) {
        const sanitizedRecord = { ...record, serializedData: safeSerializedData };
        await withStore("queries", "readwrite", (store) => store.put(sanitizedRecord)).catch(() => undefined);
      }
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

function capOperationalListRows(
  procedure: string,
  input: Record<string, unknown> | null,
  data: unknown,
): unknown {
  if (!Array.isArray(data)) return data;
  if (procedure === "inventory.listFuelReadings") {
    const requested = Number(input?.limit ?? 100);
    const limit = Math.min(100, Math.max(1, Number.isSafeInteger(requested) ? requested : 100));
    return [...data].sort((left, right) => {
      const a = left && typeof left === "object" ? left as Record<string, unknown> : {};
      const b = right && typeof right === "object" ? right as Record<string, unknown> : {};
      const aTime = Date.parse(String(a.recorded_at ?? a.recordedAt ?? ""));
      const bTime = Date.parse(String(b.recorded_at ?? b.recordedAt ?? ""));
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0) ||
        Number(b.reading_id ?? b.id ?? 0) - Number(a.reading_id ?? a.id ?? 0);
    }).slice(0, limit);
  }
  if (procedure === "inventory.listFuelEvents") {
    return [...data].sort((left, right) => {
      const a = left && typeof left === "object" ? left as Record<string, unknown> : {};
      const b = right && typeof right === "object" ? right as Record<string, unknown> : {};
      const at = Date.parse(String(a.occurred_at ?? a.occurredAt ?? ""));
      const bt = Date.parse(String(b.occurred_at ?? b.occurredAt ?? ""));
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0) ||
        Number(b.event_id ?? b.id ?? 0) - Number(a.event_id ?? a.id ?? 0);
    }).slice(0, 100).map((value) => {
      const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        id: row.id ?? row.event_id, event_id: row.event_id ?? row.id,
        generator_id: row.generator_id, generator_name: row.generator_name,
        fuel_item_id: row.fuel_item_id, fuel_item_name: row.fuel_item_name,
        source_warehouse_id: row.source_warehouse_id, source_warehouse_name: row.source_warehouse_name,
        destination_warehouse_id: row.destination_warehouse_id, destination_warehouse_name: row.destination_warehouse_name,
        litres: row.litres, occurred_at: row.occurred_at,
        level_before_liters: row.level_before_liters, level_after_liters: row.level_after_liters,
        operating_hours: row.operating_hours, reference_no: row.reference_no ?? null,
        notes: null, stock_transfer_id: row.stock_transfer_id, created_by_user_id: null, created_at: row.created_at,
      };
    });
  }
  if (procedure === "maintenance.listWorkOrders") {
    return [...data].sort((left, right) => {
      const a = left && typeof left === "object" ? left as Record<string, unknown> : {};
      const b = right && typeof right === "object" ? right as Record<string, unknown> : {};
      const at = Date.parse(String(a.reported_at ?? a.reportedAt ?? ""));
      const bt = Date.parse(String(b.reported_at ?? b.reportedAt ?? ""));
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0) ||
        Number(b.work_order_id ?? b.id ?? 0) - Number(a.work_order_id ?? a.id ?? 0);
    }).slice(0, 200).map((value) => {
      const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        id: row.id ?? row.work_order_id, work_order_id: row.work_order_id ?? row.id,
        work_order_number: row.work_order_number, generator_id: row.generator_id, generator_name: row.generator_name,
        preventive_plan_id: row.preventive_plan_id, order_type: row.order_type, priority: row.priority, status: row.status,
        title: row.title, description: row.description ?? null, work_summary: row.work_summary ?? null,
        reported_at: row.reported_at, scheduled_for: row.scheduled_for ?? null, started_at: row.started_at ?? null,
        completed_at: row.completed_at ?? null, assigned_to_user_id: row.assigned_to_user_id ?? null,
        assigned_supplier_id: row.assigned_supplier_id ?? null, assigned_supplier_name: row.assigned_supplier_name ?? null,
        assigned_supplier_code: row.assigned_supplier_code ?? null, operating_hours_at_open: row.operating_hours_at_open ?? null,
        operating_hours_at_close: row.operating_hours_at_close ?? null, downtime_minutes: row.downtime_minutes ?? 0,
        labor_cost: row.labor_cost ?? 0, external_service_cost: row.external_service_cost ?? 0,
        parts_cost: row.parts_cost ?? 0, total_cost_amount: row.total_cost_amount ?? 0, created_by_user_id: null,
      };
    });
  }
  if (procedure === "maintenance.listParts") {
    return [...data].map((value) => {
      const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        id: row.id ?? row.part_id, part_id: row.part_id ?? row.id, work_order_id: row.work_order_id,
        item_id: row.item_id, item_name: row.item_name, category: row.category,
        warehouse_id: row.warehouse_id, warehouse_name: row.warehouse_name, quantity: row.quantity,
        unit_cost: row.unit_cost, total_cost_amount: row.total_cost_amount,
        stock_movement_id: row.stock_movement_id, issued_at: row.issued_at, notes: null,
      };
    });
  }
  if (procedure === "maintenance.listPreventivePlans") {
    return [...data].sort((left, right) => {
      const a = left && typeof left === "object" ? left as Record<string, unknown> : {};
      const b = right && typeof right === "object" ? right as Record<string, unknown> : {};
      const priority = (row: Record<string, unknown>) =>
        row.alert_type === "overdue" || row.alertType === "overdue" ? 0
          : row.alert_type === "due_soon" || row.alertType === "due_soon" ? 1 : 2;
      const priorityDiff = priority(a) - priority(b);
      if (priorityDiff) return priorityDiff;
      const dueAt = (row: Record<string, unknown>) => {
        const value = Date.parse(String(row.next_due_at ?? row.nextDueAt ?? ""));
        return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
      };
      const dateDiff = dueAt(a) - dueAt(b);
      if (dateDiff) return dateDiff;
      return Number(a.plan_id ?? a.id ?? 0) - Number(b.plan_id ?? b.id ?? 0);
    }).slice(0, 500);
  }
  return data;
}

// Old/malformed local projections must not acquire a fabricated optimistic-lock
// token. Zero marks the version as unavailable and is rejected for offline writes.
function safeHrVersionNo(...values: unknown[]): number {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const version = typeof value === "number" ? value : Number(value);
    if (Number.isSafeInteger(version) && version > 0) return version;
  }
  return 0;
}

export function sanitizeOfflineQueryData(queryKey: readonly unknown[], data: unknown): unknown {
  const first = queryKey[0];
  if (isOfflineDashboardSnapshotQueryKey(queryKey) && data && typeof data === "object" && !Array.isArray(data)) {
    const segments = Array.isArray(first)
      ? first.filter((part): part is string => typeof part === "string")
      : typeof first === "string" ? first.split(".") : [];
    const snapshot = data as Record<string, unknown>;
    // Dashboard cache is a compact presentation snapshot, not an offline copy
    // of private debtor/invoice detail. Those rows are fetched live when online.
    if (segments[2] === "financialOverview") {
      return { ...snapshot, topDebtors: [], outstandingInvoices: [] };
    }
    if (segments[2] === "periodMetrics") {
      return { ...snapshot, outstandingInvoices: [] };
    }
    return data;
  }
  const segments = Array.isArray(first) ? first.filter((part): part is string => typeof part === "string")
    : typeof first === "string" ? first.split(".") : [];
  if (segments[0] === "powerhub" && segments[1] === "expenses" && segments[2] === "filterAccounts" && Array.isArray(data)) {
    const isRow = (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value));
    return data.filter(isRow).map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? ""),
      accountType: String(row.accountType ?? row.account_type ?? ""),
    })).filter((row) => Number.isSafeInteger(row.id) && row.id > 0 && row.name.length > 0);
  }
  if (segments[0] === "powerhub" && segments[1] === "inventory" && segments[2] === "fuelWorkspaceOptions" &&
      data && typeof data === "object" && !Array.isArray(data)) {
    const options = data as Record<string, unknown>;
    const isRow = (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value));
    const projectRows = (value: unknown, keys: readonly string[]) => Array.isArray(value)
      ? value.filter(isRow).map((row) => {
          const projected: Record<string, unknown> = {};
          for (const key of keys) if (Object.prototype.hasOwnProperty.call(row, key)) projected[key] = row[key];
          return projected;
        })
      : [];
    // Fuel selectors are a minimized snapshot only, never stock/cost/permission authority.
    return {
      generators: projectRows(options.generators, ["id", "code", "name", "fuelType", "fuelLevelLiters", "operatingHours", "status"]),
      generatorTanks: projectRows(options.generatorTanks, ["id", "code", "name", "generatorId"]),
      fuelItems: projectRows(options.fuelItems, ["id", "sku", "name", "baseUnit"]),
      sourceLocations: projectRows(options.sourceLocations, ["id", "code", "name", "locationType"]),
    };
  }
  if (segments[0] === "powerhub" && segments[1] === "hr" && Array.isArray(data)) {
    const isRow = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
    if (segments[2] === "offlineDirectory") return data.filter(isRow).map((row) => ({
      id: row.id, tenantId: row.tenantId ?? row.tenant_id, siteId: row.siteId ?? row.site_id ?? null,
      fullName: row.fullName ?? row.full_name ?? "", jobTitle: row.jobTitle ?? row.job_title ?? "other",
      employmentStatus: row.employmentStatus ?? row.employment_status ?? "active",
      contractType: row.contractType ?? row.contract_type ?? "monthly", createdAt: row.createdAt ?? row.created_at,
      versionNo: safeHrVersionNo(row.versionNo, row.version_no),
      pendingOffline: Boolean(row.pendingOffline),
    }));
    if (segments[2] === "offlineAttendance") return data.filter(isRow).map((row) => {
      const attendance = isRow(row.attendance) ? row.attendance : row;
      const employee = isRow(row.employee) ? row.employee : {};
      return {
        id: row.id ?? attendance.id, tenantId: row.tenantId ?? row.tenant_id ?? attendance.tenantId ?? attendance.tenant_id,
        siteId: row.siteId ?? row.site_id ?? attendance.siteId ?? attendance.site_id,
        attendance: {
          id: attendance.id, tenantId: attendance.tenantId ?? attendance.tenant_id,
          employeeId: attendance.employeeId ?? attendance.employee_id, siteId: attendance.siteId ?? attendance.site_id,
          workDate: attendance.workDate ?? attendance.work_date, regularHours: attendance.regularHours ?? attendance.regular_hours ?? 0,
          overtimeHours: attendance.overtimeHours ?? attendance.overtime_hours ?? 0, absentDays: attendance.absentDays ?? attendance.absent_days ?? 0,
          notes: null, createdByUserId: null, createdAt: attendance.createdAt ?? attendance.created_at, updatedAt: attendance.updatedAt ?? attendance.updated_at,
            versionNo: safeHrVersionNo(attendance.versionNo, attendance.version_no),
          pendingOffline: Boolean(attendance.pendingOffline),
        },
        employee: {
          id: employee.id, tenantId: employee.tenantId ?? employee.tenant_id, siteId: employee.siteId ?? employee.site_id ?? null,
          fullName: employee.fullName ?? employee.full_name ?? "", jobTitle: employee.jobTitle ?? employee.job_title ?? "other",
          employmentStatus: employee.employmentStatus ?? employee.employment_status ?? "active",
        },
      };
    });
    if (segments[2] === "offlineEmployeeAdvances") return data.filter(isRow).map((row) => {
      const adjustment = isRow(row.adjustment) ? row.adjustment : {};
      const employee = isRow(row.employee) ? row.employee : {};
      const repayments = Array.isArray(row.repayments) ? row.repayments.filter(isRow).map((payment) => ({
        id: payment.id, amount: payment.amount, repaymentMethod: payment.repaymentMethod,
        companyAccountId: payment.companyAccountId ?? null, accountTransactionId: null,
        payrollRunId: payment.payrollRunId ?? null, paymentDate: payment.paymentDate,
        referenceNo: null, notes: null, createdByUserId: null, createdAt: payment.createdAt,
      })) : [];
      return {
        adjustment: {
          id: adjustment.id, tenantId: adjustment.tenantId ?? adjustment.tenant_id,
          employeeId: adjustment.employeeId ?? adjustment.employee_id, siteId: adjustment.siteId ?? adjustment.site_id,
          adjustmentType: "advance", advanceKind: adjustment.advanceKind ?? adjustment.advance_kind,
          monthlyDeduction: adjustment.monthlyDeduction ?? adjustment.monthly_deduction ?? null,
          amount: adjustment.amount, remainingAmount: adjustment.remainingAmount ?? adjustment.remaining_amount,
          reason: null, status: adjustment.status, createdByUserId: null,
          createdAt: adjustment.createdAt ?? adjustment.created_at, updatedAt: adjustment.updatedAt ?? adjustment.updated_at,
          pendingOffline: Boolean(adjustment.pendingOffline),
        },
        employee: {
          id: employee.id, tenantId: employee.tenantId ?? employee.tenant_id, siteId: employee.siteId ?? employee.site_id ?? null,
          fullName: employee.fullName ?? employee.full_name ?? "", jobTitle: employee.jobTitle ?? employee.job_title ?? "other",
          employmentStatus: employee.employmentStatus ?? employee.employment_status ?? "active",
        },
        repayments,
      };
    });
    if (segments[2] === "offlineCompanyAccountOptions") return data.filter(isRow).map((row) => ({
      id: row.id, name: String(row.name ?? ""), accountType: String(row.accountType ?? row.account_type ?? "other"),
      isActive: Boolean(row.isActive ?? row.is_active),
    }));
    if (segments[2] === "offlinePayrollRuns") return data.filter(isRow).map((row) => ({
      id: row.id, tenantId: row.tenantId ?? row.tenant_id, siteId: row.siteId ?? row.site_id ?? null,
      period: row.period, status: row.status, totalGross: row.totalGross ?? row.total_gross ?? "0",
      totalDeductions: row.totalDeductions ?? row.total_deductions ?? "0",
      totalNet: row.totalNet ?? row.total_net ?? "0", paidAt: row.paidAt ?? row.paid_at ?? null,
      createdAt: row.createdAt ?? row.created_at, updatedAt: row.updatedAt ?? row.updated_at,
      pendingOffline: Boolean(row.pendingOffline),
    }));
  }
  if (isSafeFilteredOperationalSnapshot(queryKey, segments) && Array.isArray(data)) {
    const isRow = (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value));
    const fields = segments[2] === "listFuelEvents"
      ? [
          "id", "event_id", "tenant_id", "site_id", "generator_id", "generator_name",
          "fuel_item_name", "source_warehouse_id", "source_warehouse_name",
          "destination_warehouse_id", "destination_warehouse_name", "litres",
          "occurred_at", "level_before_liters", "level_after_liters",
          "operating_hours", "reference_no",
        ]
      : [
          "id", "reading_id", "tenant_id", "site_id", "generator_id", "generator_name",
          "reading_type", "tank_warehouse_id", "tank_name", "reading_value",
          "recorded_at", "reference_no", "corrects_reading_id",
        ];
    return data.filter(isRow).slice(0, 100).map((row) => {
      const projected: Record<string, unknown> = {};
      for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(row, field)) projected[field] = row[field];
      }
      return projected;
    });
  }
  const queryWrapper = queryKey[1];
  const queryOptions = queryWrapper && typeof queryWrapper === "object" && !Array.isArray(queryWrapper)
    ? queryWrapper as Record<string, unknown> : null;
  const queryRawInput = queryOptions && Object.prototype.hasOwnProperty.call(queryOptions, "input")
    ? queryOptions.input : queryOptions;
  const queryInput = queryRawInput && typeof queryRawInput === "object" && !Array.isArray(queryRawInput)
    ? queryRawInput as Record<string, unknown> : null;
  if (isSafeSupplierLedgerStatementSnapshot(queryKey, segments) &&
      data && typeof data === "object" && !Array.isArray(data)) {
    const source = data as Record<string, unknown>;
    const isRow = (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value));
    const supplier = isRow(source.supplier) ? source.supplier : {};
    const entries = Array.isArray(source.entries) ? source.entries.filter(isRow) : [];
    return {
      offlineSnapshot: true,
      supplier: { id: supplier.id, name: supplier.name, supplier_code: supplier.supplier_code ?? null },
      site_id: Number(queryInput?.siteId),
      balance: source.balance,
      entry_count: source.entry_count,
      entries: entries.slice(0, 200).map((entry) => ({
        id: entry.id, entry_type: entry.entry_type,
        debit_amount: entry.debit_amount, credit_amount: entry.credit_amount,
        purchase_id: entry.purchase_id ?? null,
        supplier_payment_id: entry.supplier_payment_id ?? null,
        supplier_return_id: entry.supplier_return_id ?? null,
        reference_no: entry.reference_no ?? null,
        description: entry.description, occurred_at: entry.occurred_at, created_at: entry.created_at,
      })),
    };
  }
  if (isSafeSupplierPayablesAgingSnapshot(queryKey, segments) &&
      data && typeof data === "object" && !Array.isArray(data)) {
    const source = data as Record<string, unknown>;
    const isRow = (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value));
    if (!isRow(source.totals) || !Array.isArray(source.rows) || source.rows.length > 500) return data;
    const totals = source.totals;
    const rows = source.rows.filter(isRow).slice(0, 500).map((row) => ({
      document_type: row.document_type, document_id: row.document_id,
      supplier_id: row.supplier_id, supplier_name: row.supplier_name,
      document_number: row.document_number, document_date: row.document_date,
      due_date: row.due_date, gross_amount: row.gross_amount,
      paid_amount: row.paid_amount, credit_amount: row.credit_amount,
      outstanding_amount: row.outstanding_amount, days_overdue: row.days_overdue,
      aging_bucket: row.aging_bucket,
    }));
    return {
      offlineSnapshot: true, as_of_date: source.as_of_date ?? queryInput?.asOfDate ?? null,
      totals: {
        not_due: totals.not_due, days_1_30: totals.days_1_30, days_31_60: totals.days_31_60,
        days_61_90: totals.days_61_90, days_91_plus: totals.days_91_plus,
        total_outstanding: totals.total_outstanding,
      },
      rows, cached_row_count: rows.length, complete: rows.length === source.rows.length,
    };
  }
  if (isSafePurchaseDetailSnapshot(queryKey, segments) &&
      data && typeof data === "object" && !Array.isArray(data)) {
    const source = data as Record<string, unknown>;
    const purchase = source.purchase && typeof source.purchase === "object" && !Array.isArray(source.purchase)
      ? source.purchase as Record<string, unknown> : {};
    const isRow = (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === "object" && !Array.isArray(value));
    const rows = (value: unknown) => Array.isArray(value) ? value.filter(isRow) : [];
    const project = (row: Record<string, unknown>, fields: readonly string[]) => {
      const safe: Record<string, unknown> = {};
      for (const field of fields) if (Object.prototype.hasOwnProperty.call(row, field)) safe[field] = row[field];
      return safe;
    };
    const safeLines = rows(source.lines).slice(0, 300).map((line) => project(line, [
      "id", "purchase_id", "item_id", "quantity", "unit", "units_to_base_factor",
      "received_quantity", "itemName", "itemSku", "baseUnit",
    ]));
    const safeReceipts = rows(source.receipts).slice(0, 100).map((receipt) => ({
      ...project(receipt, ["id", "receipt_number", "receipt_date", "received_at", "created_at"]),
      notes: null,
    }));
    const safeReturns = rows(source.returns).slice(0, 100).map((supplierReturn) => ({
      ...project(supplierReturn, ["id", "return_number", "return_date", "status", "returned_at"]),
      reason: null,
      notes: null,
      total_credit_amount: null,
      stock_cost_amount: null,
      refund_amount: null,
      refund_company_account_id: null,
      lines: rows(supplierReturn.lines).slice(0, 300).map((line) => project(line, [
        "id", "return_id", "purchase_line_id", "quantity", "base_quantity", "itemName", "unit",
      ])),
    }));

    return {
      offlineSnapshot: true,
      canViewFinancials: false,
      purchase: {
        ...project(purchase, [
          "id", "tenant_id", "site_id", "supplier_id", "warehouse_id", "purchase_number",
          "invoice_date", "status", "received_at", "confirmed_at", "created_at", "updated_at",
          "supplierName", "supplierCode", "warehouseName",
        ]),
        supplier_invoice_no: null,
        due_date: null,
        total_amount: null,
        subtotal_amount: null,
        discount_amount: null,
        tax_amount: null,
        other_charges_amount: null,
        payment_terms_days: null,
        reference_no: null,
        notes: null,
        paidAmount: null,
        supplierReturnCreditAmount: null,
        outstandingAmount: null,
        canViewFinancials: false,
      },
      lines: safeLines,
      receipts: safeReceipts,
      returns: safeReturns,
      payments: [],
    };
  }
  if (segments[0] === "powerhub" && data && Array.isArray(data)) {
    const options = queryKey[1];
    const wrapper = options && typeof options === "object" && !Array.isArray(options)
      ? options as Record<string, unknown>
      : null;
    const rawInput = wrapper && Object.prototype.hasOwnProperty.call(wrapper, "input")
      ? wrapper.input
      : wrapper;
    const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? rawInput as Record<string, unknown>
      : null;
    const procedure = `${segments[1]}.${segments[2]}`;
    const bounded = capOperationalListRows(procedure, input, data);
    if (bounded !== data) return bounded;
  }
  if (segments[0] !== "powerhub" || segments[1] !== "payments" || segments[2] !== "page" ||
      !data || typeof data !== "object" || Array.isArray(data)) return data;
  const page = data as Record<string, unknown>;
  if (!Array.isArray(page.items)) return data;
  return { ...page, items: page.items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const row = item as Record<string, unknown>;
    if (!row.payment || typeof row.payment !== "object" || Array.isArray(row.payment)) return item;
    const payment = row.payment as Record<string, unknown>;
    const hasReceiptImage = Boolean(payment.hasReceiptImage || payment.receiptImageKey ||
      payment.receipt_image_key || payment.receiptImageUrl || payment.receipt_image_url);
    const safePayment = { ...payment };
    // Strip both current and legacy snake/camel-case names so pre-upgrade cache
    // records cannot retain signed URLs, private storage paths, or image hashes.
    for (const key of [
      "receiptImageUrl", "receiptImageKey", "receiptImageHash",
      "receipt_image_url", "receipt_image_key", "receipt_image_hash",
    ]) delete safePayment[key];
    safePayment.hasReceiptImage = hasReceiptImage;
    return { ...row, payment: safePayment };
  }) };
}

async function persistOfflineQueryWithPolicy(
  query: Query,
  userId: string,
  now: number,
  requiredForDeltaSync: boolean,
): Promise<void> {
  if (query.state.status !== "success" || query.state.data === undefined) {
    if (requiredForDeltaSync) throw new Error("لا يمكن تثبيت مؤشر Delta دون بيانات استعلام ناجحة قابلة للحفظ.");
    return;
  }
  if (!isOfflineCacheableQueryKey(query.queryKey)) {
    if (requiredForDeltaSync) throw new Error("استعلام Delta المطلوب غير مصرح بحفظه في الكاش المحلي.");
    return;
  }

  const serializedQueryKey = offlineQueryCacheKey(query.queryKey);
  const safeData = sanitizeOfflineQueryData(query.queryKey, query.state.data);
  if (isSafeSupplierPayablesAgingSnapshot(query.queryKey)) {
    const rows = safeData && typeof safeData === "object" && !Array.isArray(safeData)
      ? (safeData as Record<string, unknown>).rows : null;
    if (!Array.isArray(rows) || rows.length > 500 ||
        (safeData as Record<string, unknown>).complete !== true) {
      await deleteQueryCacheKeys([userId + ":" + offlineQueryCacheKey(query.queryKey)]).catch(() => undefined);
      return;
    }
  }
  const serializedData = superjson.stringify(safeData);
  if (new TextEncoder().encode(serializedData).byteLength > OFFLINE_QUERY_CACHE_MAX_RECORD_BYTES) {
    if (requiredForDeltaSync) {
      throw new Error("تجاوزت نسخة Delta الحد الأقصى لحجم سجل الكاش المحلي؛ لم يُثبّت المؤشر.");
    }
    await deleteQueryCacheKeys([userId + ":" + serializedQueryKey]).catch(() => undefined);
    return;
  }
  const cacheKeyParts = query.queryKey[0];
  const cacheKeySegments = Array.isArray(cacheKeyParts)
    ? cacheKeyParts.filter((part): part is string => typeof part === "string")
    : typeof cacheKeyParts === "string" ? cacheKeyParts.split(".") : [];
  const isHrProjection = cacheKeySegments[0] === "powerhub" && cacheKeySegments[1] === "hr" &&
    ["offlineDirectory", "offlineAttendance", "offlineEmployeeAdvances", "offlinePayrollRuns", "offlineCompanyAccountOptions"].includes(cacheKeySegments[2] ?? "");
  const hrCacheTtl = ["offlineEmployeeAdvances", "offlinePayrollRuns", "offlineCompanyAccountOptions"].includes(cacheKeySegments[2] ?? "")
    ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const isPurchaseDetailSnapshot = isSafePurchaseDetailSnapshot(query.queryKey);
  const isSupplierFinancialSnapshot = isSafeSupplierLedgerStatementSnapshot(query.queryKey) ||
    isSafeSupplierPayablesAgingSnapshot(query.queryKey);
  const isExpenseFilterOptions = cacheKeySegments[0] === "powerhub" &&
    cacheKeySegments[1] === "expenses" && cacheKeySegments[2] === "filterAccounts";
  const record: OfflineQueryRecord = {
    key: userId + ":" + serializedQueryKey,
    userId,
    serializedQueryKey,
    serializedData,
    updatedAt: query.state.dataUpdatedAt || now,
    // Operational snapshots are retained across days; freshness is handled by sync cursors,
    // not by expiring the whole snapshot on a wall-clock TTL. Size and scope limits still apply.
    expiresAt: isPurchaseDetailSnapshot ? now + 24 * 60 * 60 * 1000
      : isSupplierFinancialSnapshot ? now + OFFLINE_SUPPLIER_FINANCIAL_SNAPSHOT_TTL_MS
      : isHrProjection ? now + hrCacheTtl
      : isExpenseFilterOptions ? now + OFFLINE_EXPENSE_FILTER_OPTIONS_TTL_MS
        : (isOfflineDashboardSnapshotQueryKey(query.queryKey) || isOfflineDashboardRevisionQueryKey(query.queryKey))
          ? now + OFFLINE_DASHBOARD_SNAPSHOT_TTL_MS : null,
  };

  try {
    if (requiredForDeltaSync) {
      await withCommittedStore("queries", "readwrite", (store) => store.put(record));
    } else {
      await withStore("queries", "readwrite", (store) => store.put(record));
    }
    // Do not launch cache pruning from the required path before the Delta cursor
    // is committed. Maintenance stays attached to ordinary best-effort writes.
    if (!requiredForDeltaSync) {
      successfulWritesSincePrune += 1;
      if (successfulWritesSincePrune >= 20) {
        successfulWritesSincePrune = 0;
        void pruneOfflineQueryCache(now);
      }
    }
  } catch (error) {
    if (requiredForDeltaSync) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`تعذر حفظ نسخة الكاش المطلوبة قبل تثبيت مؤشر Delta: ${detail}`);
    }
    // Offline persistence is an enhancement; never let it break the live query.
  }
}

/** Best-effort persistence for ordinary successful queries; storage failure never blocks live UX. */
export async function persistOfflineQuery(query: Query, userId: string, now = Date.now()) {
  await persistOfflineQueryWithPolicy(query, userId, now, false);
}

/**
 * Mandatory durable persistence for a query snapshot that is about to be
 * checkpointed by Delta sync. Rejects if the record cannot be saved or its
 * IndexedDB transaction fails, including an abort after request.onsuccess.
 */
export async function persistOfflineQueryForDeltaSync(query: Query, userId: string, now = Date.now()) {
  await persistOfflineQueryWithPolicy(query, userId, now, true);
}

/**
 * Purge persisted minimized HR projections for one user/site after the server
 * explicitly denies access. A later reload must not rehydrate a revoked snapshot.
 * This deliberately leaves Outbox operations intact for review/reconciliation.
 */
/** Exact allowlist used to purge only the caller's persisted HR projections for one site. */
export function isOfflineHrProjectionQueryKeyForSite(
  queryKey: readonly unknown[],
  siteId: number,
  procedures: readonly string[] = ["offlineDirectory", "offlineAttendance", "offlineEmployeeAdvances", "offlinePayrollRuns", "offlineCompanyAccountOptions"],
): boolean {
  if (!Number.isSafeInteger(siteId) || siteId < 1) return false;
  const first = queryKey[0];
  const segments = Array.isArray(first)
    ? first.filter((part): part is string => typeof part === "string")
    : typeof first === "string" ? first.split(".") : [];
  const procedure = segments[2] ?? "";
  if (segments[0] !== "powerhub" || segments[1] !== "hr" ||
      !["offlineDirectory", "offlineAttendance", "offlineEmployeeAdvances",
        "offlinePayrollRuns", "offlineCompanyAccountOptions"].includes(procedure) ||
      !procedures.includes(procedure)) return false;
  const wrapper = queryKey[1];
  if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) return false;
  const recordOptions = wrapper as Record<string, unknown>;
  const input = Object.prototype.hasOwnProperty.call(recordOptions, "input") ? recordOptions.input : recordOptions;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const scopedInput = input as Record<string, unknown>;
  return Object.keys(scopedInput).length === 1 &&
    Object.prototype.hasOwnProperty.call(scopedInput, "siteId") &&
    Number(scopedInput.siteId) === siteId;
}

/**
 * Purge persisted minimized HR projections for one user/site after the server
 * explicitly denies access. A later reload must not rehydrate a revoked snapshot.
 * This deliberately leaves Outbox operations intact for review/reconciliation.
 */
/** Match persisted fuel event/reading snapshots for exactly one branch. */
export function isOfflineFuelQueryKeyForSite(
  queryKey: readonly unknown[],
  siteId: number,
  procedures: readonly string[] = ["listFuelEvents", "listFuelReadings"],
): boolean {
  if (!Number.isSafeInteger(siteId) || siteId < 1 || procedures.length === 0) return false;
  const first = queryKey[0];
  const segments = Array.isArray(first)
    ? first.filter((part): part is string => typeof part === "string")
    : typeof first === "string" ? first.split(".") : [];
  const procedure = segments[2] ?? "";
  if (segments[0] !== "powerhub" || segments[1] !== "inventory" ||
      !["listFuelEvents", "listFuelReadings"].includes(procedure) ||
      !procedures.includes(procedure)) return false;
  const wrapper = queryKey[1];
  if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) return false;
  const options = wrapper as Record<string, unknown>;
  const input = Object.prototype.hasOwnProperty.call(options, "input") ? options.input : options;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return Number((input as Record<string, unknown>).siteId) === siteId;
}

/** Purge filtered fuel snapshots for this identity/site only; Outbox is a separate store. */
export async function clearOfflineFuelQueryCacheForSite(
  userId: string,
  siteId: number,
  procedures: readonly string[] = ["listFuelEvents", "listFuelReadings"],
) {
  if (!userId || !Number.isSafeInteger(siteId) || siteId < 1 || procedures.length === 0) return;
  try {
    const records = await withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly", (store) => store.getAll());
    const keys = records.filter((record) => {
      if (record.userId !== userId) return false;
      try {
        return isOfflineFuelQueryKeyForSite(
          superjson.parse<readonly unknown[]>(record.serializedQueryKey), siteId, procedures,
        );
      } catch {
        return false;
      }
    }).map((record) => record.key);
    await deleteQueryCacheKeys(keys);
  } catch {
    // UI access-denial guards also hide the query immediately.
  }
}

/** Match only the exact getPurchase detail query for one user/site/purchase. */
export function isOfflinePurchaseDetailQueryKeyForSite(
  queryKey: readonly unknown[],
  siteId: number,
  purchaseId?: number,
): boolean {
  if (!Number.isSafeInteger(siteId) || siteId < 1 ||
      (purchaseId !== undefined && (!Number.isSafeInteger(purchaseId) || purchaseId < 1))) return false;
  const first = queryKey[0];
  const segments = Array.isArray(first)
    ? first.filter((part): part is string => typeof part === "string")
    : typeof first === "string" ? first.split(".") : [];
  if (segments.length !== 3 || segments[0] !== "powerhub" ||
      segments[1] !== "inventory" || segments[2] !== "getPurchase") return false;
  const wrapper = queryKey[1];
  if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) return false;
  const options = wrapper as Record<string, unknown>;
  const input = Object.prototype.hasOwnProperty.call(options, "input") ? options.input : options;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const scoped = input as Record<string, unknown>;
  return Number(scoped.siteId) === siteId &&
    Number.isSafeInteger(scoped.purchaseId) && Number(scoped.purchaseId) > 0 &&
    (purchaseId === undefined || Number(scoped.purchaseId) === purchaseId);
}

/** Purge denied purchase detail snapshots only; the shared Outbox is untouched. */
export function isOfflineSupplierFinancialQueryKeyForSite(queryKey: readonly unknown[], siteId: number): boolean {
  if (!Number.isSafeInteger(siteId) || siteId < 1) return false;
  const first = queryKey[0];
  const segments = Array.isArray(first) ? first.filter((part): part is string => typeof part === "string")
    : typeof first === "string" ? first.split(".") : [];
  if (segments.length !== 3 || segments[0] !== "powerhub" || segments[1] !== "inventory" ||
      !["supplierLedgerStatement", "supplierPayablesAging"].includes(segments[2] ?? "")) return false;
  const wrapper = queryKey[1];
  if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) return false;
  const options = wrapper as Record<string, unknown>;
  const rawInput = Object.prototype.hasOwnProperty.call(options, "input") ? options.input : options;
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return false;
  return Number((rawInput as Record<string, unknown>).siteId) === siteId &&
    (segments[2] === "supplierLedgerStatement"
      ? isSafeSupplierLedgerStatementSnapshot(queryKey, segments)
      : isSafeSupplierPayablesAgingSnapshot(queryKey, segments));
}

export async function clearOfflineSupplierFinancialQueryCacheForSite(userId: string, siteId: number) {
  if (!userId || !Number.isSafeInteger(siteId) || siteId < 1) return;
  try {
    const records = await withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly", (store) => store.getAll());
    const keys = records.filter((record) => {
      if (record.userId !== userId) return false;
      try {
        return isOfflineSupplierFinancialQueryKeyForSite(
          superjson.parse<readonly unknown[]>(record.serializedQueryKey), siteId,
        );
      } catch { return false; }
    }).map((record) => record.key);
    await deleteQueryCacheKeys(keys);
  } catch {
    // UI must also hide data after explicit authorization denial.
  }
}

export async function clearOfflinePurchaseDetailQueryCacheForSite(
  userId: string,
  siteId: number,
  purchaseId?: number,
) {
  if (!userId || !Number.isSafeInteger(siteId) || siteId < 1 ||
      (purchaseId !== undefined && (!Number.isSafeInteger(purchaseId) || purchaseId < 1))) return;
  try {
    const records = await withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly", (store) => store.getAll());
    const keys = records.filter((record) => {
      if (record.userId !== userId) return false;
      try {
        return isOfflinePurchaseDetailQueryKeyForSite(
          superjson.parse<readonly unknown[]>(record.serializedQueryKey), siteId, purchaseId,
        );
      } catch {
        return false;
      }
    }).map((record) => record.key);
    await deleteQueryCacheKeys(keys);
  } catch {
    // Explicit denial is hidden by the UI; cleanup is best effort.
  }
}

export async function clearOfflineHrProjectionCacheForSite(
  userId: string,
  siteId: number,
  procedures: readonly string[] = ["offlineDirectory", "offlineAttendance", "offlineEmployeeAdvances", "offlinePayrollRuns", "offlineCompanyAccountOptions"],
) {
  if (!userId || !Number.isSafeInteger(siteId) || siteId < 1 || procedures.length === 0) return;
  try {
    const records = await withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly", (store) => store.getAll());
    const keys = records.filter((record) => {
      if (record.userId !== userId) return false;
      try {
        return isOfflineHrProjectionQueryKeyForSite(
          superjson.parse<readonly unknown[]>(record.serializedQueryKey), siteId, procedures,
        );
      } catch {
        return false;
      }
    }).map((record) => record.key);
    await deleteQueryCacheKeys(keys);
  } catch {
    // UI access-denial guards still hide the data if storage cleanup is unavailable.
  }
}

export async function clearOfflineQueryCacheForUser(userId: string) {
  try {
    const records = await withStore<OfflineQueryRecord[]>(QUERY_STORE, "readonly", (store) => store.getAll());
    await deleteQueryCacheKeys(records.filter((record) => record.userId === userId).map((record) => record.key));
  } catch {
    // Best-effort privacy cleanup must not break the sign-out flow.
  }
  await clearOperationalReportSnapshotsForUser(userId);
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
