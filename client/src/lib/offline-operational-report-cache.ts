export type OperationalReportType = "fuel-consumption" | "maintenance";
export type OperationalReportFilters = Record<string, string | number | null>;
export type OperationalReportSnapshot = {
  key: string;
  userId: number;
  siteId: number;
  reportType: OperationalReportType;
  filters: OperationalReportFilters;
  rows: Record<string, unknown>[];
  savedAt: number;
};

export const OFFLINE_OPERATIONAL_REPORT_TTL_MS = 24 * 60 * 60 * 1000;
const DATABASE_NAME = "powerhub-offline-operational-report-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";
const MAX_OPERATIONAL_REPORT_SNAPSHOTS = 50;
const FUEL_FIELDS = [
  "generator_id", "generator_name", "tank_warehouse_id", "tank_name",
  "fuel_filled_liters", "fuel_filled_cost", "recorded_consumption_liters",
  "opening_level_liters", "ending_level_liters", "actual_consumption_liters",
  "opening_operating_hours", "ending_operating_hours", "operating_hours_delta",
  "litres_per_hour", "measurement_status",
] as const;
const MAINTENANCE_FIELDS = [
  "generator_id", "generator_name", "fault_title", "work_order_count",
  "breakdown_count", "preventive_count", "completed_count", "open_count",
  "downtime_minutes", "parts_cost", "labor_cost", "external_service_cost",
  "total_cost_amount", "first_reported_at", "last_reported_at",
] as const;

function sanitizeRows(reportType: OperationalReportType, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const fields: readonly string[] = reportType === "fuel-consumption" ? FUEL_FIELDS : MAINTENANCE_FIELDS;
  return value.filter((row): row is Record<string, unknown> =>
    row !== null && typeof row === "object" && !Array.isArray(row)
  ).map((row) => {
    const safe: Record<string, unknown> = {};
    for (const field of fields) {
      const entry = row[field];
      if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) safe[field] = entry;
    }
    return safe;
  });
}

function makeKey(input: Pick<OperationalReportSnapshot, "userId" | "siteId" | "reportType" | "filters">) {
  return JSON.stringify([input.userId, input.siteId, input.reportType, input.filters]);
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("لا يدعم هذا المتصفح تخزين التقارير التشغيلية محليًا."));
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن التقارير التشغيلية المحلي."));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    let result!: T;
    let requestSucceeded = false;
    const close = () => database.close();
    let request: IDBRequest<T>;
    try {
      request = action(transaction.objectStore(STORE_NAME));
    } catch (error) {
      try { transaction.abort(); } catch { /* transaction may not have started */ }
      close();
      reject(error instanceof Error ? error : new Error("تعذر تنفيذ التخزين المحلي للتقرير."));
      return;
    }
    request.onsuccess = () => { requestSucceeded = true; result = request.result; };
    request.onerror = () => {
      close();
      reject(request.error ?? new Error("تعذر تنفيذ طلب التقرير المحلي."));
    };
    transaction.oncomplete = () => {
      close();
      if (!requestSucceeded) reject(new Error("اكتملت معاملة التقرير دون نتيجة."));
      else resolve(result);
    };
    transaction.onerror = () => { close(); reject(transaction.error ?? new Error("فشلت معاملة التقرير المحلي.")); };
    transaction.onabort = () => { close(); reject(transaction.error ?? new Error("أُلغيت معاملة التقرير المحلي.")); };
  });
}

export function getUsableOperationalReportSnapshot(
  snapshot: OperationalReportSnapshot | null | undefined,
  input: Pick<OperationalReportSnapshot, "userId" | "siteId" | "reportType" | "filters">,
  options: { authorizationDenied?: boolean; accessAllowed?: boolean; now?: number } = {},
): OperationalReportSnapshot | undefined {
  const now = options.now ?? Date.now();
  if (!snapshot || options.authorizationDenied || options.accessAllowed === false) return undefined;
  if (snapshot.key !== makeKey(input) || snapshot.userId !== input.userId || snapshot.siteId !== input.siteId ||
      snapshot.reportType !== input.reportType || JSON.stringify(snapshot.filters) !== JSON.stringify(input.filters)) return undefined;
  if (!Number.isFinite(snapshot.savedAt) || snapshot.savedAt > now ||
      now - snapshot.savedAt >= OFFLINE_OPERATIONAL_REPORT_TTL_MS) return undefined;
  return { ...snapshot, rows: sanitizeRows(input.reportType, snapshot.rows) };
}

export async function saveOperationalReportSnapshot(
  input: Pick<OperationalReportSnapshot, "userId" | "siteId" | "reportType" | "filters"> & { rows: unknown },
) {
  if (!Number.isSafeInteger(input.userId) || input.userId < 1 ||
      !Number.isSafeInteger(input.siteId) || input.siteId < 1) {
    throw new Error("نطاق التقرير التشغيلي المحلي غير صالح.");
  }
  const snapshot: OperationalReportSnapshot = {
    ...input,
    key: makeKey(input),
    filters: { ...input.filters },
    rows: sanitizeRows(input.reportType, input.rows),
    savedAt: Date.now(),
  };
  await transact("readwrite", (store) => store.put(snapshot));
  const existing = await transact<OperationalReportSnapshot[]>("readonly", (store) => store.getAll());
  const eligible = existing
    .filter((row) => Number.isFinite(row.savedAt) && row.savedAt <= Date.now() &&
      Date.now() - row.savedAt < OFFLINE_OPERATIONAL_REPORT_TTL_MS)
    .sort((left, right) => right.savedAt - left.savedAt);
  const keep = new Set(eligible.slice(0, MAX_OPERATIONAL_REPORT_SNAPSHOTS).map((row) => row.key));
  const remove = existing.filter((row) => !keep.has(row.key)).map((row) => row.key);
  if (remove.length) await transact("readwrite", (store) => {
    for (const key of remove) store.delete(key);
    return store.getAllKeys();
  });
  return snapshot;
}

export async function loadOperationalReportSnapshot(
  input: Pick<OperationalReportSnapshot, "userId" | "siteId" | "reportType" | "filters">,
  options: { authorizationDenied?: boolean; accessAllowed?: boolean; now?: number } = {},
) {
  if (!Number.isSafeInteger(input.userId) || input.userId < 1 ||
      !Number.isSafeInteger(input.siteId) || input.siteId < 1 ||
      options.authorizationDenied || options.accessAllowed === false) return undefined;
  const snapshot = await transact<OperationalReportSnapshot | undefined>("readonly", (store) => store.get(makeKey(input)));
  const usable = getUsableOperationalReportSnapshot(snapshot, input, options);
  if (!usable && snapshot) {
    await transact("readwrite", (store) => store.delete(snapshot.key));
    return undefined;
  }
  return usable;
}
