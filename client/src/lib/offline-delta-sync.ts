export type DeltaEntityType = "sites" | "subscribers" | "generators" | "readings" | "tariffs";

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

const DB_NAME = "powerhub-offline-delta-sync";
const DB_VERSION = 2;
const CURSOR_STORE = "cursors";
const ENTITY_STORE = "entities";

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

export function compareDeltaCursors(a: string, b: string) {
  const left = BigInt(assertCursor(a));
  const right = BigInt(assertCursor(b));
  return left < right ? -1 : left > right ? 1 : 0;
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

function openDatabase() {
  if (typeof indexedDB === "undefined") throw new Error("لا يدعم هذا المتصفح حفظ بيانات المزامنة.");
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CURSOR_STORE)) {
        db.createObjectStore(CURSOR_STORE, { keyPath: ["userId", "tenantId", "siteId", "entityType"] });
      }
      if (!db.objectStoreNames.contains(ENTITY_STORE)) {
        const entities = db.createObjectStore(ENTITY_STORE, { keyPath: ["scopeKey", "entityId"] });
        entities.createIndex("byScope", "scopeKey", { unique: false });
        entities.createIndex("byUser", "userId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مخزن المزامنة المحلي."));
    request.onblocked = () => reject(new Error("تعذر ترقية مخزن المزامنة؛ أغلق تبويبات PowerHub الأخرى ثم أعد المحاولة."));
  });
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
    if (change.operation === "upsert" && (!change.row_data || String(change.row_data.id ?? "") !== change.entity_id)) {
      throw new Error("بيانات التغيير لا تطابق معرّف السجل.");
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
      cursors.put({ ...scope, cursor: nextCursor, updatedAt: now } satisfies DeltaCursorRecord);
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
    normalized.set(String(id), row);
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
        for (const [entityId, rowData] of normalized) {
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
    const tx = db.transaction([CURSOR_STORE, ENTITY_STORE], "readwrite");
    const cursors = tx.objectStore(CURSOR_STORE);
    const entities = tx.objectStore(ENTITY_STORE);
    const cursorRequest = cursors.getAll();
    cursorRequest.onsuccess = () => {
      for (const record of cursorRequest.result as DeltaCursorRecord[]) {
        if (record.userId === userId) cursors.delete(cursorKey(record));
      }
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
  rebuildSnapshot: (snapshotCursor: string) => Promise<readonly Row[]>;
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
      const snapshotCursor = assertCursor(page.snapshot_cursor ?? page.current_cursor);
      const snapshotRows = await input.rebuildSnapshot(snapshotCursor);
      await storage.replaceSnapshot(input.scope, snapshotRows, snapshotCursor);
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
