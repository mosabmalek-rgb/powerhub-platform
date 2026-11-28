
import { openOfflineWorkspaceDatabase } from "../../client/src/lib/offline-workspace-db";
import { replaceDeltaSnapshot, getDeltaRepairCheckpoint, listDeltaEntities, pullDeltaPages, withDeltaSyncLock, type DeltaCursorScope, type DeltaPage } from "../../client/src/lib/offline-delta-sync";

const scope: DeltaCursorScope = { userId: 1, tenantId: 2, siteId: 3, entityType: "maintenance_work_order_parts:42" };
const other = { ...scope, userId: 9 };
const row = { id: 6, tenantId: 2, siteId: 3, workOrderId: 42, itemName: "before" };
const protectedStores = ["operations", "grants", "claims", "conflicts", "syncMetadata", "fieldReadings", "orphanedFieldReadings", "bootstrapState"];
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
function equal(actual: unknown, expected: unknown, label: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), label);
}
async function seedProtected() {
  const db = await openOfflineWorkspaceDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(protectedStores, "readwrite");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error("seed failed")); };
    for (const userId of [1, 9]) {
      for (const [i, status] of ["pending", "retryable", "conflict"].entries()) {
        const id = userId + ":" + status;
        const record = { id, operationId: id, clientOperationId: id, userId, tenantId: 2, siteId: 3,
          entityType: "invoice", numberValue: i + 10, grantId: "grant:" + userId, scopeKey: id,
          outcome: status, payload: { amount: 25, marker: id }, attempts: i };
        for (const name of protectedStores) tx.objectStore(name).put(record);
      }
    }
  });
}
async function readProtected(): Promise<unknown[]> {
  const db = await openOfflineWorkspaceDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(protectedStores, "readonly");
    const result: unknown[] = [];
    protectedStores.forEach((name, i) => {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => { result[i] = [name, req.result]; };
    });
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error("read failed")); };
  });
}
async function assertScope(cursor: string, version: number, name: string) {
  equal(await getDeltaRepairCheckpoint(scope), { cursor, repairVersion: version }, "checkpoint mismatch");
  equal((await listDeltaEntities(scope)).map(x => x.rowData), [{ ...row, itemName: name }], "entity mismatch");
  equal(await getDeltaRepairCheckpoint(other), { cursor: "3", repairVersion: 1 }, "other checkpoint changed");
  equal((await listDeltaEntities(other)).map(x => x.rowData), [row], "other entities changed");
}
async function rejectAction(task: Promise<unknown>, label: string) {
  let rejected = false;
  try { await task; } catch { rejected = true; }
  check(rejected, label);
}
async function report(result: Record<string, unknown>) {
  await fetch("/result", { method: "POST", body: JSON.stringify(result), headers: { "Content-Type": "application/json" } });
}
async function runPeer() {
  check(location.hostname === "127.0.0.1" && window.parent !== window, "isolated peer only");
  const send = (type: string, data: Record<string, unknown> = {}) =>
    window.parent.postMessage({ type, ...data }, location.origin);
  await new Promise<void>((resolve, reject) => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== "start") return;
      window.removeEventListener("message", receive);
      const pending = withDeltaSyncLock(scope, async () => {
        const checkpoint = await getDeltaRepairCheckpoint(scope);
        send("peer-acquired", { checkpoint });
      });
      send("peer-requested");
      pending.then(resolve, reject);
    };
    window.addEventListener("message", receive);
    send("peer-ready");
  });
}

async function repairWithNativePeer() {
  check(!!navigator.locks, "native Web Locks unavailable");
  const frame = document.createElement("iframe");
  frame.src = "/peer";
  const messages = new Map<string, any>();
  const waiters = new Map<string, (value: any) => void>();
  const receive = (event: MessageEvent) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || typeof event.data?.type !== "string") return;
    messages.set(event.data.type, event.data);
    waiters.get(event.data.type)?.(event.data);
  };
  const wait = (type: string): Promise<any> => messages.has(type)
    ? Promise.resolve(messages.get(type))
    : new Promise(resolve => waiters.set(type, resolve));
  window.addEventListener("message", receive);
  try {
    await withDeltaSyncLock(scope, async () => {
      document.body.append(frame);
      await wait("peer-ready");
      frame.contentWindow!.postMessage({ type: "start" }, location.origin);
      await wait("peer-requested");
      // The browser must report a queued lock for this user while the parent owns it.
      const name = "powerhub:delta-sync:user:" + scope.userId;
      const state = await navigator.locks.query();
      check(state.held?.some(x => x.name === name) && state.pending?.some(x => x.name === name), "missing native cross-context lock contention");
      check(!messages.has("peer-acquired"), "peer entered before parent released");
      await withDeltaSyncLock(other, async () => {
        equal(await getDeltaRepairCheckpoint(other), { cursor: "3", repairVersion: 1 }, "independent user lock blocked or changed");
      });
      await replaceDeltaSnapshot(scope, [{ ...row, itemName: "repaired" }], "4", 3, undefined, 2);
    });
    const acquired = await wait("peer-acquired");
    equal(acquired.checkpoint, { cursor: "4", repairVersion: 2 }, "peer did not observe committed repair");
  } finally {
    window.removeEventListener("message", receive);
    frame.remove();
  }
}

async function run() {
  check(location.hostname === "127.0.0.1", "local fixture only");
  if (sessionStorage.getItem("repair-phase") === "reload") {
    const baseline = sessionStorage.getItem("protected-state");
    check(baseline, "missing persisted expectation");
    await assertScope("4", 2, "repaired");
    equal(await readProtected(), JSON.parse(baseline), "outbox changed after reload");
    let rebuilds = 0;
    const page: DeltaPage = { status: "ok", entity_type: scope.entityType, current_cursor: "5",
      retained_from_cursor: "0", snapshot_cursor: null, through_cursor: "5", next_cursor: "5", has_more: false,
      changes: [{ cursor: "5", entity_type: scope.entityType, entity_id: "6", operation: "upsert",
        row_data: { ...row, itemName: "delta" }, changed_at: "2026-11-27T00:00:00Z" }] };
    await pullDeltaPages({ scope, afterCursor: null, repairSnapshot: true, repairVersion: 2,
      rebuildSnapshot: async () => { rebuilds++; throw new Error("completed repair unexpectedly repeated"); },
      pull: async (args) => { equal(args.afterCursor, "4", "incorrect resumed checkpoint"); return page; } });
    equal(rebuilds, 0, "unexpected snapshot download");
    await assertScope("5", 2, "delta");
    equal(await readProtected(), JSON.parse(baseline), "outbox changed during delta catch-up");
    await report({ ok: true, markers: ["PR359_NATIVE_IDB_ATOMIC_ABORT_PASS", "PR359_NATIVE_IDB_RELOAD_REPAIR_PASS", "PR359_NATIVE_IDB_OUTBOX_ISOLATION_PASS", "PR359_NATIVE_WEB_LOCK_CROSS_CONTEXT_PASS"] });
    return;
  }
  await seedProtected();
  const before = await readProtected();
  check(before.length === protectedStores.length && before.every(x => Array.isArray(x) && x[1].length === 6), "incomplete seed");
  await replaceDeltaSnapshot(scope, [row], "3", 1, undefined, 1);
  await replaceDeltaSnapshot(other, [row], "3", 1, undefined, 1);
  const original = IDBObjectStore.prototype.put;
  let injected = false;
  IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
    const request = key === undefined ? original.call(this, value) : original.call(this, value, key);
    if (this.name === "cursors" && value?.repairVersion === 2 && !injected) {
      injected = true;
      this.transaction.abort();
    }
    return request;
  };
  try { await rejectAction(replaceDeltaSnapshot(scope, [{ ...row, itemName: "repaired" }], "4", 2, undefined, 2), "native abort unexpectedly committed"); }
  finally { IDBObjectStore.prototype.put = original; }
  check(injected, "native transaction abort not injected");
  await assertScope("3", 1, "before");
  equal(await readProtected(), before, "outbox changed after abort");
  await repairWithNativePeer();
  await rejectAction(replaceDeltaSnapshot(scope, [row], "4", 4, undefined, 1), "old version unexpectedly committed");
  await assertScope("4", 2, "repaired");
  equal(await readProtected(), before, "outbox changed after repair");
  sessionStorage.setItem("protected-state", JSON.stringify(before));
  sessionStorage.setItem("repair-phase", "reload");
  location.reload();
}
(location.pathname === "/peer" ? runPeer() : run()).catch(error => report({ ok: false, error: String(error?.stack ?? error) }));
