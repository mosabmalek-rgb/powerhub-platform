
import { QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import { hydrateOfflineQueryCache, offlineQueryCacheKey, persistOfflineQueryForDeltaSync } from "../../client/src/lib/offline-query-cache";
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
      // postMessage and the browser's lock service use separate asynchronous queues.
      // Observe the actual held/pending condition with a bounded deadline, not a
      // single scheduling-dependent query and not an unconditional delay.
      const deadline = performance.now() + 5000;
      let state = await navigator.locks.query();
      for (;;) {
        check(!messages.has("peer-acquired"), "peer entered before parent released");
        const held = state.held?.filter(x => x.name === name && x.mode === "exclusive") ?? [];
        const pending = state.pending?.filter(x => x.name === name && x.mode === "exclusive") ?? [];
        if (held.length === 1 && pending.length === 1) break;
        check(performance.now() < deadline, "missing native cross-context lock contention: " + JSON.stringify(state));
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        state = await navigator.locks.query();
      }
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

// Exercise the actual TanStack Query + separate IndexedDB cache store, not
// merely an injected callback rejection. The scope is independent of the peer test.
const cacheScope: DeltaCursorScope = { ...scope, entityType: "maintenance_work_order_parts:43" };
const cacheRow = { ...row, id: 7, workOrderId: 43 };
const cacheKey = [["powerhub", "maintenance", "listParts"], { input: { siteId: 3, workOrderId: 43 }, type: "query" }] as const;
const cacheData = (name: string) => [{ id: 7, part_id: 7, work_order_id: 43, item_name: name }];
async function assertHydratedCache(userId: string, expected: string) {
  const fresh = new QueryClient();
  try {
    await hydrateOfflineQueryCache(fresh, userId);
    const rows = fresh.getQueryData<{ item_name: string }[]>(cacheKey);
    equal(rows?.map(x => x.item_name), [expected], "actual durable query cache mismatch for user " + userId);
  } finally { fresh.clear(); }
}
// A legacy unsanitized record forces the asynchronous hydration rewrite.
async function hydrationRaceAcceptance() {
  const before = await readProtected();
  const serializedQueryKey = offlineQueryCacheKey(cacheKey);
  for (const mode of ["live", "identity"] as const) {
    const userId = mode === "live" ? "101" : "102";
    const client = new QueryClient();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("powerhub-offline-cache", 2);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("queries", "readwrite");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
      tx.objectStore("queries").put({
        key: userId + ":" + serializedQueryKey, userId, serializedQueryKey,
        serializedData: superjson.stringify([{ ...cacheData("legacy")[0], notes: "legacy private note" }]),
        updatedAt: 1, expiresAt: null,
      });
    });
    let active = true;
    let injected = false;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
      const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
      if (this.name === "queries" && value?.userId === userId && !injected) {
        request.addEventListener("success", () => {
          injected = true;
          if (mode === "live") client.setQueryData(cacheKey, cacheData("live"));
          else active = false;
        }, { once: true });
      }
      return request;
    };
    try {
      const hydrated = await hydrateOfflineQueryCache(client, userId, Date.now(), () => active);
      check(injected, "legacy rewrite race not exercised: " + mode);
      equal(hydrated, 0, "obsolete hydration counted: " + mode);
      equal(client.getQueryData(cacheKey), mode === "live" ? cacheData("live") : undefined,
        "obsolete hydration exposed or overwrote query: " + mode);
    } finally {
      IDBObjectStore.prototype.put = put;
      client.clear();
    }
  }
  equal(await readProtected(), before, "hydration race touched protected stores");
}
async function actualCacheRepair() {
  const client = new QueryClient();
  const before = await readProtected();
  const save = async (userId: string, name: string) => {
    client.setQueryData(cacheKey, cacheData(name));
    const query = client.getQueryCache().find({ queryKey: cacheKey, exact: true });
    check(query, "missing real TanStack query");
    await persistOfflineQueryForDeltaSync(query, userId);
  };
  try {
    await save("1", "before");
    await save("9", "other user");
    await replaceDeltaSnapshot(cacheScope, [cacheRow], "3", 1, undefined, 1);
    const assertBefore = async () => {
      equal(await getDeltaRepairCheckpoint(cacheScope), { cursor: "3", repairVersion: 1 }, "cache failure advanced checkpoint");
      equal((await listDeltaEntities(cacheScope)).map(x => x.rowData), [cacheRow], "cache failure changed entities");
      equal(await readProtected(), before, "real cache repair changed outbox");
    };
    let pulls = 0;
    const input = { scope: cacheScope, afterCursor: "3", repairSnapshot: true, repairVersion: 2,
      rebuildSnapshot: async () => ({ cursor: "4", rows: [{ ...cacheRow, itemName: "repaired" }], applyCache: () => save("1", "repaired") }),
      pull: async (args: { afterCursor: string | null }): Promise<DeltaPage> => {
        pulls++;
        equal(args.afterCursor, "4", "cache retry resumed at wrong cursor");
        await assertHydratedCache("1", "repaired");
        return { status: "ok", entity_type: cacheScope.entityType, current_cursor: "4", retained_from_cursor: "0",
          snapshot_cursor: null, through_cursor: "4", next_cursor: "4", has_more: false, changes: [] };
      } };
    const put = IDBObjectStore.prototype.put;
    let injected = false;
    IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
      const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
      if (this.name === "queries" && value?.userId === "1" && !injected) {
        const tx = this.transaction;
        request.addEventListener("success", () => { injected = true; tx.abort(); }, { once: true });
      }
      return request;
    };
    try { await rejectAction(pullDeltaPages(input), "real query-cache abort unexpectedly checkpointed"); }
    finally { IDBObjectStore.prototype.put = put; }
    check(injected, "real query-cache request success/transaction abort not injected");
    equal(pulls, 0, "cache failure reached delta pull");
    await assertBefore();
    await assertHydratedCache("1", "before");
    await assertHydratedCache("9", "other user");
    const result = await pullDeltaPages(input);
    equal(result.cursor, "4", "actual cache retry failed");
    equal(pulls, 1, "actual retry pull count");
    equal(await getDeltaRepairCheckpoint(cacheScope), { cursor: "4", repairVersion: 2 }, "actual cache retry checkpoint");
    equal((await listDeltaEntities(cacheScope)).map(x => x.rowData), [{ ...cacheRow, itemName: "repaired" }], "actual cache retry entity");
    await assertHydratedCache("9", "other user");
    equal(await readProtected(), before, "real cache retry changed outbox");
  } finally { client.clear(); }
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
    check(sessionStorage.getItem("obsolete-run-verified") === "yes", "missing obsolete-run proof");
    check(sessionStorage.getItem("cache-retry-verified") === "yes", "missing cache retry proof");
    await assertHydratedCache("1", "repaired");
    await assertHydratedCache("9", "other user");
    equal(await getDeltaRepairCheckpoint(cacheScope), { cursor: "4", repairVersion: 2 }, "real cache checkpoint lost on reload");
    check(sessionStorage.getItem("hydration-races-verified") === "yes", "missing hydration race proof");
    await report({ ok: true, markers: ["PR359_NATIVE_IDB_ATOMIC_ABORT_PASS", "PR359_NATIVE_IDB_RELOAD_REPAIR_PASS", "PR359_NATIVE_IDB_OUTBOX_ISOLATION_PASS", "PR359_NATIVE_WEB_LOCK_CROSS_CONTEXT_PASS", "PR359_NATIVE_OBSOLETE_RUN_REJECTED_PASS", "PR359_NATIVE_CACHE_FAILURE_RETRY_PASS", "PR359_NATIVE_REAL_QUERY_CACHE_ABORT_RETRY_RELOAD_PASS", "PR359_NATIVE_HYDRATION_LIVE_AND_IDENTITY_RACE_PASS"] });
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
  // A late snapshot from an obsolete authenticated run must not reach the
  // cache callback or the native IndexedDB commit. Simulate the identity
  // change at the async response boundary (not a hosted auth test).
  let active = true;
  let cacheApplications = 0;
  await rejectAction(pullDeltaPages({ scope, afterCursor: "3", repairSnapshot: true, repairVersion: 2,
    isCurrent: () => active,
    rebuildSnapshot: async () => {
      active = false;
      return { cursor: "4", rows: [{ ...row, itemName: "obsolete" }],
        applyCache: async () => { cacheApplications++; } };
    },
    pull: async () => { throw new Error("obsolete run unexpectedly reached pull"); },
  }), "obsolete snapshot unexpectedly committed");
  equal(cacheApplications, 0, "obsolete run reached cache");
  await assertScope("3", 1, "before");
  equal(await readProtected(), before, "outbox changed during obsolete run");
  sessionStorage.setItem("obsolete-run-verified", "yes");
  // Fail cache persistence before the native checkpoint, then retry with the same repair version.
  let attempts = 0;
  let pulls = 0;
  const input = { scope, afterCursor: "3", repairSnapshot: true, repairVersion: 2,
    rebuildSnapshot: async () => ({ cursor: "4", rows: [{ ...row, itemName: "repaired" }], applyCache: async () => {
      attempts++;
      if (attempts === 1) throw new Error("injected cache persistence failure");
      // Deliberately do not commit this attempt: the peer test below owns the successful repair.
      throw new Error("injected interruption before checkpoint");
    }}),
    pull: async (): Promise<DeltaPage> => { pulls++; throw new Error("failed cache attempt reached pull"); },
  };
  await rejectAction(pullDeltaPages(input), "first cache failure unexpectedly committed");
  await assertScope("3", 1, "before");
  await rejectAction(pullDeltaPages(input), "second cache failure unexpectedly committed");
  equal(attempts, 2, "repair did not retry after cache failure");
  equal(pulls, 0, "failed cache attempt reached pull");
  await assertScope("3", 1, "before");
  equal(await readProtected(), before, "outbox changed during cache failure");
  sessionStorage.setItem("cache-retry-verified", "yes");
  await actualCacheRepair();
  await hydrationRaceAcceptance();
  sessionStorage.setItem("hydration-races-verified", "yes");
  await repairWithNativePeer();
  await rejectAction(replaceDeltaSnapshot(scope, [row], "4", 4, undefined, 1), "old version unexpectedly committed");
  await assertScope("4", 2, "repaired");
  equal(await readProtected(), before, "outbox changed after repair");
  sessionStorage.setItem("protected-state", JSON.stringify(before));
  sessionStorage.setItem("repair-phase", "reload");
  location.reload();
}
(location.pathname === "/peer" ? runPeer() : run()).catch(error => report({ ok: false, error: String(error?.stack ?? error) }));
