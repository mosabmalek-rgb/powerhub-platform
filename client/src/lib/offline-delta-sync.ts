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
export type DeltaCursorScope = { userId: number; tenantId: number; siteId: number; entityType: DeltaEntityType };
export type DeltaCursorRecord = DeltaCursorScope & { cursor: string; updatedAt: number };
const DB_NAME = "powerhub-offline-delta-sync";
const DB_VERSION = 1;
const STORE = "cursors";

function assertCursor(cursor: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error("مؤشر المزامنة غير صالح.");
  return cursor;
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
  if (typeof indexedDB === "undefined") throw new Error("لا يدعم هذا المتصفح حفظ مؤشرات المزامنة.");
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ["userId", "tenantId", "siteId", "entityType"] });
        store.createIndex("byScope", ["userId", "tenantId", "siteId"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذر فتح مؤشرات المزامنة المحلية."));
  });
}
export async function getDeltaCursor(scope: DeltaCursorScope): Promise<string | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get([scope.userId, scope.tenantId, scope.siteId, scope.entityType]);
    req.onsuccess = () => resolve((req.result as DeltaCursorRecord | undefined)?.cursor ?? null);
    req.onerror = () => reject(req.error ?? new Error("تعذر قراءة مؤشر المزامنة."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر قراءة مؤشر المزامنة.")); };
  });
}
export async function setDeltaCursor(scope: DeltaCursorScope, cursor: string, now = Date.now()) {
  assertCursor(cursor);
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...scope, cursor, updatedAt: now } satisfies DeltaCursorRecord);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error("تعذر حفظ مؤشر المزامنة.")); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error("أُلغِي حفظ مؤشر المزامنة.")); };
  });
}

/**
 * Pull pages against one fixed through_cursor. The caller persists the returned
 * page changes atomically with its local entity snapshot before committing cursor.
 * This helper intentionally does not decide how each existing TanStack query shape
 * is normalized; callers must supply a transactional applyPage callback.
 */
export async function pullDeltaPages<Row extends Record<string, unknown>>(input: {
  scope: DeltaCursorScope;
  afterCursor: string | null;
  pageSize?: number;
  pull: (args: { afterCursor: string | null; throughCursor: string | null; pageSize: number }) => Promise<DeltaPage<Row>>;
  applyPage: (page: DeltaPage<Row>) => Promise<void>;
  rebuildSnapshot: (snapshotCursor: string) => Promise<void>;
}): Promise<{ cursor: string; appliedChanges: number; resetRequired: boolean }> {
  const pageSize = input.pageSize ?? 200;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error("حجم صفحة المزامنة غير صالح.");
  let cursor = input.afterCursor;
  let through: string | null = null;
  let appliedChanges = 0;
  let resetRequired = false;
  let pages = 0;
  while (pages++ < 10000) {
    const page = await input.pull({ afterCursor: cursor, throughCursor: through, pageSize });
    if (page.status === "reset_required") {
      const snapshotCursor = page.snapshot_cursor ?? page.current_cursor;
      await input.rebuildSnapshot(snapshotCursor);
      await setDeltaCursor(input.scope, snapshotCursor);
      cursor = snapshotCursor;
      through = null;
      resetRequired = true;
      continue;
    }
    if (through === null) through = page.through_cursor;
    else if (through !== page.through_cursor) throw new Error("تغيّر حد المزامنة أثناء ترقيم الصفحات.");
    if (page.changes.length) await input.applyPage(page);
    appliedChanges += page.changes.length;
    const next = page.next_cursor ?? cursor ?? "0";
    // Persist only after the page has been applied. If the browser crashes between
    // the entity write and this cursor write, the page is replayed; upsert/tombstone
    // application is idempotent, so the cursor can never outrun local data.
    await setDeltaCursor(input.scope, next);
    if (cursor !== null && compareDeltaCursors(next, cursor) < 0) throw new Error("تراجع مؤشر المزامنة.");
    cursor = next;
    if (!page.has_more) return { cursor: through, appliedChanges, resetRequired };
    if (page.changes.length === 0 || cursor === null) throw new Error("توقفت المزامنة قبل اكتمال الصفحة.");
  }
  throw new Error("تجاوزت المزامنة الحد الآمن لعدد الصفحات.");
}
