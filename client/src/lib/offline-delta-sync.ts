import { openLegacyOfflineDatabaseIfPresent, openOfflineWorkspaceDatabase } from "./offline-workspace-db";
export type DeltaEntityType = "sites" | "subscribers" | "generators" | "readings" | "tariffs" | "invoices" | "payments" | "expenses" | "company_accounts" | "company_accounts_all" | "inventory_items" | "inventory_item_units" | "suppliers" | "inventory_warehouses" | "inventory_stock_movements" | "inventory_stocktakes" | "inventory_purchase_headers" | "inventory_purchase_receipt_headers" | "inventory_supplier_return_headers" | "fuel_readings" | "maintenance_preventive_plans" | "fuel_events" | "maintenance_work_orders" | `maintenance_work_order_parts:${number}`;

export type DeltaChange<Row extends Record<string, unknown> = Record<string, unknown>> = {
  cursor: string;
  entity_type: DeltaEntityType;
  entity_id: string;
  operation: "upsert" | "delete";
  row_data: Row | null;
  changed_at: string;
};

export type DeltaPage<Row extends Record<string, unknown> = Record<string, unknown>> = {
  status: "ok" | "reset_required";
  entity_type: DeltaEntityType;
  current_cursor: string;
  retained_from_cursor: string;
  snapshot_cursor: string | null;
  through_cursor: string;
  next_cursor: string | null;
  has_more: boolean;
  changes: DeltaChange<Row>[];
};

export type DeltaCursorScope = {
  userId: number;
  tenantId: number;
  siteId: number;
  entityType: DeltaEntityType;
};
export type DeltaCursorRecord = DeltaCursorScope & { cursor: string; updatedAt: number };
export type DeltaEntityRecord<Row extends Record<string, unknown> = Record<string, unknown>> =
  DeltaCursorScope & { entityId: string; rowData: Row; updatedAt: number };

export interface DeltaSyncStorage<Row extends Record<string, unknown> = Record<string, unknown>> {
  getCursor(scope: DeltaCursorScope): Promise<string | null>;
  listEntities(scope: DeltaCursorScope): Promise<DeltaEntityRecord<Row>[]>;
  commitPage(scope: DeltaCursorScope, page: DeltaPage<Row>, nextCursor: string): Promise<void>;
  replaceSnapshot(scope: DeltaCursorScope, rows: readonly Row[], cursor: string): Promise<void>;
  clearUser(userId: number): Promise<void>;
}

const CURSOR_STORE = "cursors";
const ENTITY_STORE = "entities";

const MAX_LOCAL_STOCK_MOVEMENT_ROWS = 500;
const MAX_LOCAL_INVENTORY_STOCKTAKE_ROWS = 200;
const MAX_LOCAL_PURCHASE_HEADER_ROWS = 200;
const MAX_LOCAL_PURCHASE_CHILD_HISTORY_ROWS = 200;
const MAX_LOCAL_FUEL_READING_ROWS = 500;
const MAX_LOCAL_MAINTENANCE_PLAN_ROWS = 500;
const MAX_LOCAL_FUEL_EVENT_ROWS = 500;
const MAX_LOCAL_MAINTENANCE_WORK_ORDER_ROWS = 200;

function movementProjection(value: Record<string, unknown>): Record<string, unknown> {
  const nested = value.rowData;
  return nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : value;
}

function movementIdentity(value: Record<string, unknown>, row: Record<string, unknown>): string {
  const id = row.id ?? row.movement_id ?? value.entityId;
  return id === null || id === undefined ? "" : String(id);
}

function compareFuelReadingNewestFirst(
  leftValue: Record<string, unknown>,
  rightValue: Record<string, unknown>,
): number {
  const left = movementProjection(leftValue);
  const right = movementProjection(rightValue);
  const leftParsed = Date.parse(String(left.recorded_at ?? left.recordedAt ?? ""));
  const rightParsed = Date.parse(String(right.recorded_at ?? right.recordedAt ?? ""));
  const leftTime = Number.isFinite(leftParsed) ? leftParsed : 0;
  const rightTime = Number.isFinite(rightParsed) ? rightParsed : 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return movementIdentity(rightValue, right).localeCompare(movementIdentity(leftValue, left), undefined, { numeric: true });
}

function compareMaintenancePlanPriority(
  leftValue: Record<string, unknown>,
  rightValue: Record<string, unknown>,
): number {
  const left = movementProjection(leftValue);
  const right = movementProjection(rightValue);
  const priority = (row: Record<string, unknown>) =>
    row.alert_type === "overdue" || row.alertType === "overdue" ? 0
      : row.alert_type === "due_soon" || row.alertType === "due_soon" ? 1 : 2;
  const priorityDiff = priority(left) - priority(right);
  if (priorityDiff !== 0) return priorityDiff;
  const dueAt = (row: Record<string, unknown>) => {
    const raw = row.next_due_at ?? row.nextDueAt;
    if (raw === null || raw === undefined || raw === "") return Number.POSITIVE_INFINITY;
    const value = Date.parse(String(raw));
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  const dateDiff = dueAt(left) - dueAt(right);
  if (dateDiff !== 0) return dateDiff;
  const leftId = movementIdentity(leftValue, left);
  const rightId = movementIdentity(rightValue, right);
  try {
    const leftBigInt = BigInt(leftId);
    const rightBigInt = BigInt(rightId);
    return leftBigInt === rightBigInt ? 0 : leftBigInt < rightBigInt ? -1 : 1;
  } catch {
    return leftId.localeCompare(rightId, undefined, { numeric: true });
  }
}

function compareStockMovementNewestFirst(
  leftValue: Record<string, unknown>,
  rightValue: Record<string, unknown>,
): number {
  const left = movementProjection(leftValue);
  const right = movementProjection(rightValue);
  const leftParsed = Date.parse(String(left.occurred_at ?? left.occurredAt ?? left.reported_at ?? left.reportedAt ?? left.invoice_date ?? left.invoiceDate ?? left.received_at ?? left.receivedAt ?? left.receipt_date ?? left.receiptDate ?? left.return_date ?? left.returnDate ?? left.next_due_at ?? left.nextDueAt ?? left.created_at ?? left.createdAt ?? ""));
  const rightParsed = Date.parse(String(right.occurred_at ?? right.occurredAt ?? right.reported_at ?? right.reportedAt ?? right.invoice_date ?? right.invoiceDate ?? right.received_at ?? right.receivedAt ?? right.receipt_date ?? right.receiptDate ?? right.return_date ?? right.returnDate ?? right.next_due_at ?? right.nextDueAt ?? right.created_at ?? right.createdAt ?? ""));
  const leftTime = Number.isFinite(leftParsed) ? leftParsed : 0;
  const rightTime = Number.isFinite(rightParsed) ? rightParsed : 0;
  if (leftTime !== rightTime) return rightTime - leftTime;

  const leftId = movementIdentity(leftValue, left);
  const rightId = movementIdentity(rightValue, right);
  try {
    const leftBigInt = BigInt(leftId);
    const rightBigInt = BigInt(rightId);
    if (leftBigInt === rightBigInt) return 0;
    return leftBigInt > rightBigInt ? -1 : 1;
  } catch {
    return rightId.localeCompare(leftId, undefined, { numeric: true });
  }
}

/**
 * Keep the bounded stock-movement feed bounded in IndexedDB as well as in the UI.
 * Accepts either projected rows or stored entity records that wrap rowData.
 */
export function limitDeltaEntityRows<T extends Record<string, unknown>>(
  entityType: DeltaEntityType,
  rows: readonly T[],
): T[] {
  const limit = entityType === "inventory_stock_movements"
    ? MAX_LOCAL_STOCK_MOVEMENT_ROWS
    : entityType === "inventory_stocktakes"
      ? MAX_LOCAL_INVENTORY_STOCKTAKE_ROWS
      : entityType === "inventory_purchase_headers"
        ? MAX_LOCAL_PURCHASE_HEADER_ROWS
        : entityType === "inventory_purchase_receipt_headers" || entityType === "inventory_supplier_return_headers"
          ? MAX_LOCAL_PURCHASE_CHILD_HISTORY_ROWS
          : entityType === "fuel_readings"
            ? MAX_LOCAL_FUEL_READING_ROWS
            : entityType === "maintenance_preventive_plans"
              ? MAX_LOCAL_MAINTENANCE_PLAN_ROWS
              : entityType === "fuel_events"
                ? MAX_LOCAL_FUEL_EVENT_ROWS
                : entityType === "maintenance_work_orders"
                  ? MAX_LOCAL_MAINTENANCE_WORK_ORDER_ROWS
                  : null;
  if (limit === null || rows.length <= limit) return [...rows];
  if (entityType === "fuel_readings") {
    return [...rows].sort(compareFuelReadingNewestFirst).slice(0, limit);
  }
  if (entityType === "maintenance_preventive_plans") {
    return [...rows].sort(compareMaintenancePlanPriority).slice(0, limit);
  }
  if (entityType.startsWith("maintenance_work_order_parts:")) return [...rows];
  return [...rows].sort(compareStockMovementNewestFirst).slice(0, limit);
}

function assertCursor(cursor: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error("مؤشر المزامنة غير صالح.");
  return cursor;
}

function scopeKey(scope: DeltaCursorScope) {
  if (![scope.userId, scope.tenantId, scope.siteId].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("نطاق التخزين المحلي للمزامنة غير صالح.");
  }
  return [scope.userId, scope.tenantId, scope.siteId, scope.entityType].join(":");
}

type DeltaSyncLockManager = {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T>;
};

const inProcessDeltaRuns = new Map<string, Promise<void>>();

function browserDeltaSyncLockManager(): DeltaSyncLockManager | undefined {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return undefined;
  return (navigator as Navigator & { locks?: DeltaSyncLockManager }).locks;
}

/**
 * Serializes one user's Delta work across tabs when Web Locks are available.
 * Query projections can be shared across sites and entity feeds, so a per-cursor
 * lock would still allow stale writes into the same persisted query record. The
 * fallback serializes callers in this tab; cursor compare-and-commit still
 * fails closed if a non-cooperating tab races it.
 */
export async function withDeltaSyncLock<T>(
  scope: DeltaCursorScope,
  task: () => Promise<T>,
  lockManager: DeltaSyncLockManager | null | undefined = browserDeltaSyncLockManager(),
): Promise<T> {
  // Query-cache projections can be shared by several sites and entity feeds
  // (for example sites.list and payment/subscriber relationship projections).
  // Serialize a user's entire Delta run, not merely one entity cursor scope.
  scopeKey(scope); // Validate every cursor-scope component before acquiring any lock.
  const name = `powerhub:delta-sync:user:${scope.userId}`;
  if (lockManager) {
    return lockManager.request(name, { mode: "exclusive" }, task);
  }

  const previous = inProcessDeltaRuns.get(name);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  inProcessDeltaRuns.set(name, current);
  if (previous) await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (inProcessDeltaRuns.get(name) === current) inProcessDeltaRuns.delete(name);
  }
}

export function compareDeltaCursors(a: string, b: string) {
  const left = BigInt(assertCursor(a));
  const right = BigInt(assertCursor(b));
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Fail closed when a server snapshot/change contains a row outside its requested tenant/site. */
export function assertDeltaRowWithinScope(
  entityType: DeltaEntityType,
  row: Record<string, unknown>,
  scope: Pick<DeltaCursorScope, "tenantId" | "siteId">,
): void {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const valueOf = (record: Record<string, unknown>, camel: string, snake: string) =>
    record[camel] ?? record[snake];
  const primary = entityType === "readings" && isRecord(row.reading) ? row.reading : row;
  const tenantId = Number(valueOf(primary, "tenantId", "tenant_id"));
  const siteId = Number(valueOf(primary, "siteId", "site_id"));
  const identityMatches = entityType === "sites"
    ? Number(primary.id) === scope.siteId && tenantId === scope.tenantId
    : tenantId === scope.tenantId && siteId === scope.siteId;
  if (!identityMatches) {
    throw new Error("سجل المزامنة خارج نطاق المستأجر أو الفرع المطلوب.");
  }
  if (entityType.startsWith("maintenance_work_order_parts:")) {
    const match = /^maintenance_work_order_parts:([1-9][0-9]{0,15})$/.exec(entityType);
    const expectedWorkOrderId = match ? Number(match[1]) : Number.NaN;
    const rowWorkOrderId = Number(valueOf(primary, "workOrderId", "work_order_id"));
    if (!Number.isSafeInteger(expectedWorkOrderId) || rowWorkOrderId !== expectedWorkOrderId) {
      throw new Error("سجل قطع الغيار خارج نطاق أمر الصيانة المطلوب.");
    }
  }

  // Joined page projections must not smuggle a related record from another scope.
  const related: Array<{ label: string; value: unknown }> = [];
  if (entityType === "readings" && isRecord(row.subscriber)) {
    related.push({ label: "subscriber", value: row.subscriber });
  }
  if (entityType === "payments") {
    if (isRecord(row.payment)) related.push({ label: "payment", value: row.payment });
    if (isRecord(row.subscriber)) related.push({ label: "subscriber", value: row.subscriber });
  }
  for (const relation of related) {
    const record = relation.value as Record<string, unknown>;
    if (Number(valueOf(record, "tenantId", "tenant_id")) !== scope.tenantId ||
        Number(valueOf(record, "siteId", "site_id")) !== scope.siteId) {
      throw new Error(`العلاقة ${relation.label} في سجل المزامنة خارج نطاق المستأجر أو الفرع.`);
    }
  }
}

export function applyDeltaChanges<Row extends Record<string, unknown>>(
  current: readonly Row[],
  changes: readonly DeltaChange<Row>[],
  idKey = "id",
): Row[] {
  const records = new Map<string, Row>();
  for (const row of current) {
    const id = row[idKey];
    if (id !== undefined && id !== null) records.set(String(id), row);
  }
  let previousCursor: string | null = null;
  for (const change of changes) {
    assertCursor(change.cursor);
    if (previousCursor !== null && compareDeltaCursors(change.cursor, previousCursor) <= 0) {
      throw new Error("ترتيب تغييرات المزامنة غير صالح أو يحتوي مؤشراً مكرراً.");
    }
    previousCursor = change.cursor;
    if (change.operation === "delete") {
      records.delete(change.entity_id);
      continue;
    }
    if (!change.row_data || String(change.row_data[idKey] ?? "") !== change.entity_id) {
      throw new Error("بيانات التغيير لا تطابق معرّف السجل.");
    }
    records.set(change.entity_id, change.row_data);
  }
  return [...records.values()];
}


let legacyDeltaMigration: Promise<void> | null = null;

async function migrateLegacyDeltaDatabase(target: IDBDatabase) {
  const legacy = await openLegacyOfflineDatabaseIfPresent("powerhub-offline-delta-sync", [CURSOR_STORE, ENTITY_STORE]);
  if (!legacy) return;
  const legacyData = await new Promise<{
    cursors: DeltaCursorRecord[];
    entities: Array<DeltaEntityRecord & { scopeKey: string }>;
  }>((resolve, reject) => {
    const tx = legacy.transaction([CURSOR_STORE, ENTITY_STORE], "readonly");
    const cursorsRequest = tx.objectStore(CURSOR_STORE).getAll();
    const entitiesRequest = tx.objectStore(ENTITY_STORE).getAll();
    let cursors: DeltaCursorRecord[] = [];
    let entities: Array<DeltaEntityRecord & { scopeKey: string }> = [];
    cursorsRequest.onsuccess = () => { cursors = cursorsRequest.result as DeltaCursorRecord[]; };
    entitiesRequest.onsuccess = () => { entities = entitiesRequest.result as Array<DeltaEntityRecord & { scopeKey: string }>; };
    cursorsRequest.onerror = () => { try { tx.abort(); } catch {} };
    entitiesRequest.onerror = () => { try { tx.abort(); } catch {} };
    tx.oncomplete = () => { legacy.close(); resolve({ cursors, entities }); };
    tx.onerror = () => { legacy.close(); reject(tx.error ?? new Error("تعذر قراءة مؤشرات المزامنة السابقة.")); };
    tx.onabort = () => { legacy.close(); reject(tx.error ?? new Error("أُلغيت قراءة مؤشرات المزامنة السابقة.")); };
  });
  if (!legacyData.cursors.length) return;

  await new Promise<void>((resolve, reject) => {
    const tx = target.transaction([CURSOR_STORE, ENTITY_STORE], "readwrite");
    const cursorStore = tx.objectStore(CURSOR_STORE);
    const entityStore = tx.objectStore(ENTITY_STORE);
    const cursorsRequest = cursorStore.getAll();
    const entitiesRequest = entityStore.getAll();
    let existingCursors: DeltaCursorRecord[] = [];
    let existingEntities: Array<DeltaEntityRecord & { scopeKey: string }> = [];
    let cursorsReady = false;
    let entitiesReady = false;
    let copied = false;
    const merge = () => {
      if (copied || !cursorsReady || !entitiesReady) return;
      copied = true;
      const presentScopeKeys = new Set(existingCursors.map((row) => scopeKey(row)));
      const copiedScopes = new Set<string>();
      const presentEntityKeys = new Set(existingEntities.map((row) => `${row.scopeKey}|${row.entityId}`));
      for (const record of legacyData.cursors) {
        const key = scopeKey(record);
        if (presentScopeKeys.has(key)) continue;
        cursorStore.put(record);
        copiedScopes.add(key);
      }
      for (const record of legacyData.entities) {
        if (!copiedScopes.has(record.scopeKey)) continue;
        if (presentEntityKeys.has(`${record.scopeKey}|${record.entityId}`)) continue;
        entityStore.put(record);
      }
    };
    cursorsRequest.onsuccess = () => { existingCursors = cursorsRequest.result as DeltaCursorRecord[]; cursorsReady = true; merge(); };
    entitiesRequest.onsuccess = () => { existingEntities = entitiesRequest.result as Array<DeltaEntityRecord & { scopeKey: string }>; entitiesReady = true; merge(); };
    cursorsRequest.onerror = () => { try { tx.abort(); } catch {} };
    entitiesRequest.onerror = () => { try { tx.abort(); } catch {} };
    tx.oncomplete = () => {
      resolve();
      const removal = indexedDB.deleteDatabase("powerhub-offline-delta-sync");
      removal.onerror = () => undefined;
      removal.onblocked = () => undefined;
    };
    tx.onerror = () => reject(tx.error ?? new Error("تعذر ترحيل مؤشرات المزامنة القديمة."));
    tx.onabort = () => reject(tx.error ?? new Error("أُلغِي ترحيل مؤشرات المزامنة القديمة."));
  });
}

async function openDatabase() {
  const db = await openOfflineWorkspaceDatabase();
  if (!legacyDeltaMigration) {
    legacyDeltaMigration = migrateLegacyDeltaDatabase(db).catch((error) => {
      console.warn("[PowerHub] Legacy Delta cache migration deferred to a server snapshot.", error);
    });
  }
  await legacyDeltaMigration;
  return db;
}


function cursorKey(scope: DeltaCursorScope) {
  return [scope.userId, scope.tenantId, scope.siteId, scope.entityType];
}

export async function getDeltaCursor(scope: DeltaCursorScope): Promise<string | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CURSOR_STORE, "readonly");
    const request = tx.objectStore(CURSOR_STORE).get(cursorKey(scope));
    request.onsuccess = () => resolve((request.result as DeltaCursorRecord | undefined)?.cursor ?? null);
    request.onerror = () => reject(request.error ?? new Error("تعذر قراءة مؤشر المزامنة."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر قراءة مؤشر المزامنة.")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("أُلغيت قراءة مؤشر المزامنة.")); };
  });
}


export type DeltaSyncStatusRecord = DeltaCursorScope & {
  cursor: string;
  lastSyncedAt: number | null;
  lastAttemptAt: number;
  outcome: "success" | "failed";
  lastError?: string;
};

export async function getDeltaSyncStatus(scope: DeltaCursorScope): Promise<DeltaSyncStatusRecord | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("syncState", "readonly");
    const request = tx.objectStore("syncState").get(cursorKey(scope));
    request.onsuccess = () => resolve(request.result as DeltaSyncStatusRecord | undefined);
    request.onerror = () => reject(request.error ?? new Error("تعذر قراءة حالة المزامنة."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر قراءة حالة المزامنة.")); };
  });
}

export async function saveDeltaSyncStatus(record: DeltaSyncStatusRecord): Promise<void> {
  assertCursor(record.cursor);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("syncState", "readwrite");
    tx.objectStore("syncState").put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر حفظ حالة المزامنة.")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("أُلغي حفظ حالة المزامنة.")); };
  });
}

export async function listDeltaSyncStatuses(options: { userId: number; siteId?: number }): Promise<DeltaSyncStatusRecord[]> {
  if (!Number.isSafeInteger(options.userId) || options.userId < 1) return [];
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("syncState", "readonly");
    const request = tx.objectStore("syncState").getAll();
    request.onsuccess = () => resolve((request.result as DeltaSyncStatusRecord[])
      .filter((row) => row.userId === options.userId && (options.siteId === undefined || row.siteId === options.siteId))
      .sort((a, b) => b.lastAttemptAt - a.lastAttemptAt));
    request.onerror = () => reject(request.error ?? new Error("تعذر قراءة حالات المزامنة."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر قراءة حالات المزامنة.")); };
  });
}

export async function setDeltaCursor(scope: DeltaCursorScope, cursor: string, now = Date.now()) {
  assertCursor(cursor);
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CURSOR_STORE, "readwrite");
    tx.objectStore(CURSOR_STORE).put({ ...scope, cursor, updatedAt: now } satisfies DeltaCursorRecord);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر حفظ مؤشر المزامنة.")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("أُلغِي حفظ مؤشر المزامنة.")); };
  });
}

export async function listDeltaEntities<Row extends Record<string, unknown> = Record<string, unknown>>(
  scope: DeltaCursorScope,
): Promise<DeltaEntityRecord<Row>[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ENTITY_STORE, "readonly");
    const index = tx.objectStore(ENTITY_STORE).index("byScope");
    const request = index.getAll(IDBKeyRange.only(scopeKey(scope)));
    request.onsuccess = () => resolve(request.result as DeltaEntityRecord<Row>[]);
    request.onerror = () => reject(request.error ?? new Error("تعذر قراءة سجل المزامنة المحلي."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر قراءة سجل المزامنة المحلي.")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("أُلغيت قراءة سجل المزامنة المحلي.")); };
  });
}

/** Atomically applies one server page and advances the cursor in the same IndexedDB transaction. */
export async function commitDeltaPage<Row extends Record<string, unknown>>(
  scope: DeltaCursorScope,
  page: DeltaPage<Row>,
  nextCursor: string,
  now = Date.now(),
) {
  const key = scopeKey(scope);
  assertCursor(nextCursor);
  if (page.status !== "ok" || page.entity_type !== scope.entityType) throw new Error("صفحة المزامنة لا تطابق نطاقها.");
  let priorChangeCursor: string | null = null;
  for (const change of page.changes) {
    assertCursor(change.cursor);
    if (change.entity_type !== scope.entityType) throw new Error("نوع التغيير لا يطابق نطاق المزامنة.");
    if (priorChangeCursor !== null && compareDeltaCursors(change.cursor, priorChangeCursor) <= 0) {
      throw new Error("ترتيب تغييرات المزامنة غير صالح.");
    }
    priorChangeCursor = change.cursor;
    if (change.operation === "upsert") {
      if (!change.row_data || String(change.row_data.id ?? "") !== change.entity_id) {
        throw new Error("بيانات التغيير لا تطابق معرّف السجل.");
      }
      assertDeltaRowWithinScope(scope.entityType, change.row_data, scope);
    }
    if (change.operation === "delete" && change.row_data !== null) throw new Error("علامة حذف المزامنة تحتوي بيانات غير متوقعة.");
    if (compareDeltaCursors(change.cursor, page.through_cursor) > 0 ||
        compareDeltaCursors(change.cursor, nextCursor) > 0) {
      throw new Error("تجاوز تغيير حد صفحة المزامنة.");
    }
  }
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([CURSOR_STORE, ENTITY_STORE], "readwrite");
    const cursors = tx.objectStore(CURSOR_STORE);
    const entities = tx.objectStore(ENTITY_STORE);
    let rejected = false;
    const failTransaction = (message: string) => {
      if (rejected) return;
      rejected = true;
      try { tx.abort(); } catch {}
      reject(new Error(message));
    };
    const existingCursorRequest = cursors.get(cursorKey(scope));
    existingCursorRequest.onerror = () => failTransaction("تعذر التحقق من مؤشر المزامنة الحالي.");
    existingCursorRequest.onsuccess = () => {
      if (rejected) return;
      const existing = (existingCursorRequest.result as DeltaCursorRecord | undefined)?.cursor ?? "0";
      if (compareDeltaCursors(nextCursor, existing) < 0) {
        failTransaction("وصلت صفحة مزامنة أقدم من البيانات المحفوظة؛ أعد قراءة المؤشر.");
        return;
      }
      // If another tab already committed this cursor or a later one, do not replay
      // stale entities over fresher local records.
      if (compareDeltaCursors(nextCursor, existing) === 0) return;
      for (const change of page.changes) {
        if (compareDeltaCursors(change.cursor, existing) <= 0) {
          failTransaction("تحتوي الصفحة على تغيير أقدم من المؤشر المحلي؛ أعد طلب الصفحة من المؤشر الحالي.");
          return;
        }
      }
      for (const change of page.changes) {
        const entityKey: [string, string] = [key, change.entity_id];
        if (change.operation === "delete") {
          entities.delete(entityKey);
        } else {
          entities.put({
            scopeKey: key,
            ...scope,
            entityId: change.entity_id,
            rowData: change.row_data,
            updatedAt: now,
          });
        }
      }
      if (
        scope.entityType === "inventory_stock_movements" ||
        scope.entityType === "inventory_stocktakes" ||
        scope.entityType === "inventory_purchase_headers" ||
        scope.entityType === "inventory_purchase_receipt_headers" ||
        scope.entityType === "inventory_supplier_return_headers" ||
        scope.entityType === "fuel_readings" ||
        scope.entityType === "maintenance_preventive_plans" ||
        scope.entityType === "fuel_events" ||
        scope.entityType === "maintenance_work_orders"
      ) {
        // Keep every bounded entity sidecar in the same transaction as mutations and cursor.
        const retainedRequest = entities.index("byScope").getAll(IDBKeyRange.only(key));
        retainedRequest.onerror = () => failTransaction("تعذر تقليص سجل المزامنة المحلي.");
        retainedRequest.onsuccess = () => {
          if (rejected) return;
          const stored = retainedRequest.result as Array<Record<string, unknown>>;
          const retainedIds = new Set(
            limitDeltaEntityRows(scope.entityType, stored).map((record) => String(record.entityId)),
          );
          for (const record of stored) {
            const entityId = String(record.entityId);
            if (!retainedIds.has(entityId)) entities.delete([key, entityId]);
          }
          cursors.put({ ...scope, cursor: nextCursor, updatedAt: now } satisfies DeltaCursorRecord);
        };
      } else {
        cursors.put({ ...scope, cursor: nextCursor, updatedAt: now } satisfies DeltaCursorRecord);
      }
    };
    tx.oncomplete = () => { db.close(); if (!rejected) resolve(); };
    tx.onerror = () => { db.close(); if (!rejected) reject(tx.error ?? new Error("تعذر تثبيت صفحة المزامنة.")); };
    tx.onabort = () => { db.close(); if (!rejected) reject(tx.error ?? new Error("أُلغيت عملية تثبيت صفحة المزامنة.")); };
  });
}

/** Replaces a full snapshot and commits its checkpoint atomically. */
export async function replaceDeltaSnapshot<Row extends Record<string, unknown>>(
  scope: DeltaCursorScope,
  rows: readonly Row[],
  cursor: string,
  now = Date.now(),
) {
  const key = scopeKey(scope);
  assertCursor(cursor);
  const normalized = new Map<string, Row>();
  for (const row of rows) {
    const id = row.id;
    if (id === undefined || id === null || String(id).length === 0) throw new Error("لقطة المزامنة تحتوي سجلًا دون معرّف.");
    assertDeltaRowWithinScope(scope.entityType, row, scope);
    normalized.set(String(id), row);
  }
  const boundedRows = limitDeltaEntityRows(scope.entityType, [...normalized.values()]);
  const boundedNormalized = new Map<string, Row>(
    boundedRows.map((row) => [String(row.id), row]),
  );
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([CURSOR_STORE, ENTITY_STORE], "readwrite");
    const cursors = tx.objectStore(CURSOR_STORE);
    const entities = tx.objectStore(ENTITY_STORE);
    let rejected = false;
    const failTransaction = (message: string) => {
      if (rejected) return;
      rejected = true;
      try { tx.abort(); } catch {}
      reject(new Error(message));
    };
    const request = cursors.get(cursorKey(scope));
    request.onerror = () => failTransaction("تعذر التحقق من مؤشر لقطة المزامنة.");
    request.onsuccess = () => {
      if (rejected) return;
      const existing = (request.result as DeltaCursorRecord | undefined)?.cursor ?? "0";
      if (compareDeltaCursors(cursor, existing) < 0) {
        failTransaction("لقطة أقدم من مؤشر محلي أحدث؛ أعد المحاولة بالمؤشر الحالي.");
        return;
      }
      const index = entities.index("byScope");
      const keysRequest = index.getAllKeys(IDBKeyRange.only(key));
      keysRequest.onerror = () => failTransaction("تعذر تجهيز استبدال لقطة المزامنة.");
      keysRequest.onsuccess = () => {
        if (rejected) return;
        for (const entityKey of keysRequest.result) entities.delete(entityKey);
        for (const [entityId, rowData] of boundedNormalized) {
          entities.put({ scopeKey: key, ...scope, entityId, rowData, updatedAt: now });
        }
        cursors.put({ ...scope, cursor, updatedAt: now } satisfies DeltaCursorRecord);
      };
    };
    tx.oncomplete = () => { db.close(); if (!rejected) resolve(); };
    tx.onerror = () => { db.close(); if (!rejected) reject(tx.error ?? new Error("تعذر استبدال لقطة المزامنة.")); };
    tx.onabort = () => { db.close(); if (!rejected) reject(tx.error ?? new Error("أُلغيت عملية استبدال لقطة المزامنة.")); };
  });
}

export async function clearDeltaSyncDataForUser(userId: number) {
  if (!Number.isSafeInteger(userId) || userId < 1) return;
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([CURSOR_STORE, ENTITY_STORE, "syncState"], "readwrite");
    const cursors = tx.objectStore(CURSOR_STORE);
    const entities = tx.objectStore(ENTITY_STORE);
    const syncState = tx.objectStore("syncState");
    const cursorRequest = cursors.getAll();
    cursorRequest.onsuccess = () => {
      for (const record of cursorRequest.result as DeltaCursorRecord[]) {
        if (record.userId === userId) cursors.delete(cursorKey(record));
      }
      const stateRequest = syncState.getAll();
      stateRequest.onsuccess = () => {
        for (const record of stateRequest.result as DeltaSyncStatusRecord[]) {
          if (record.userId === userId) syncState.delete(cursorKey(record));
        }
      };
      stateRequest.onerror = () => { try { tx.abort(); } catch {} };
    };
    cursorRequest.onerror = () => { try { tx.abort(); } catch {} };
    const entityKeysRequest = entities.index("byUser").getAllKeys(IDBKeyRange.only(userId));
    entityKeysRequest.onsuccess = () => {
      for (const key of entityKeysRequest.result) entities.delete(key);
    };
    entityKeysRequest.onerror = () => { try { tx.abort(); } catch {} };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر تنظيف بيانات المزامنة للمستخدم.")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("أُلغِي تنظيف بيانات المزامنة للمستخدم.")); };
  });
}

const indexedDbStorage: DeltaSyncStorage = {
  getCursor: getDeltaCursor,
  listEntities: listDeltaEntities,
  commitPage: commitDeltaPage,
  replaceSnapshot: replaceDeltaSnapshot,
  clearUser: clearDeltaSyncDataForUser,
};

/**
 * Pulls pages against one fixed through_cursor. A page and its cursor commit in a
 * single local transaction; if a page is replayed after interruption, the local
 * store rejects an older cursor rather than overwriting fresher records.
 */
export async function pullDeltaPages<Row extends Record<string, unknown>>(input: {
  scope: DeltaCursorScope;
  afterCursor: string | null;
  pageSize?: number;
  pull: (args: { afterCursor: string | null; throughCursor: string | null; pageSize: number }) => Promise<DeltaPage<Row>>;
  applyPage?: (page: DeltaPage<Row>) => Promise<void>;
  rebuildSnapshot: (requestedCursor: string) => Promise<{ cursor: string; rows: readonly Row[] }>;
  storage?: DeltaSyncStorage<Row>;
}): Promise<{ cursor: string; appliedChanges: number; resetRequired: boolean }> {
  const pageSize = input.pageSize ?? 200;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error("حجم صفحة المزامنة غير صالح.");
  const storage = input.storage ?? indexedDbStorage as DeltaSyncStorage<Row>;
  let cursor = input.afterCursor;
  let through: string | null = null;
  let appliedChanges = 0;
  let resetRequired = false;
  let pages = 0;
  while (pages++ < 10000) {
    const page = await input.pull({ afterCursor: cursor, throughCursor: through, pageSize });
    if (page.entity_type !== input.scope.entityType) throw new Error("استجابة المزامنة لا تطابق نوع البيانات المطلوب.");
    if (page.status === "reset_required") {
      const snapshot = await input.rebuildSnapshot(assertCursor(page.snapshot_cursor ?? page.current_cursor));
      const snapshotCursor = assertCursor(snapshot.cursor);
      await storage.replaceSnapshot(input.scope, snapshot.rows, snapshotCursor);
      cursor = snapshotCursor;
      through = null;
      resetRequired = true;
      continue;
    }

    assertCursor(page.current_cursor);
    assertCursor(page.through_cursor);
    if (through === null) through = page.through_cursor;
    else if (through !== page.through_cursor) throw new Error("تغيّر حد المزامنة أثناء ترقيم الصفحات.");
    if (compareDeltaCursors(page.through_cursor, page.current_cursor) > 0) throw new Error("تجاوز حد المزامنة مؤشر الخادم الحالي.");
    const next = assertCursor(page.next_cursor ?? cursor ?? "0");
    if (page.has_more && compareDeltaCursors(next, page.through_cursor) >= 0) throw new Error("مؤشر الصفحة لا يتقدم نحو حد المزامنة.");
    if (!page.has_more && next !== page.through_cursor) throw new Error("الصفحة النهائية لا تنتهي عند حد المزامنة.");
    if (page.has_more && page.changes.length === 0) throw new Error("توقفت المزامنة قبل اكتمال الصفحة.");
    if (cursor !== null && compareDeltaCursors(next, cursor) < 0) throw new Error("تراجع مؤشر المزامنة.");
    // Update the live query cache and await its durable offline-cache write
    // before advancing the separate delta cursor. If the browser stops here,
    // the old cursor causes a safe idempotent replay instead of a skipped change.
    if (input.applyPage && page.changes.length) await input.applyPage(page);
    await storage.commitPage(input.scope, page, next);
    appliedChanges += page.changes.length;
    cursor = next;
    if (!page.has_more) return { cursor: through, appliedChanges, resetRequired };
  }
  throw new Error("تجاوزت المزامنة الحد الآمن لعدد الصفحات.");
}
