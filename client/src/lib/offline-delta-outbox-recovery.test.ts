import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeReadyOperations } from "./offline-sync-executor";
import type { SyncMetadata } from "./offline-sync-engine";
import type { QueuedOfflineWork } from "./offline-work-queue";
import { openOfflineWorkspaceDatabase } from "./offline-workspace-db";
import { clearDeltaSyncDataForUser, pullDeltaPages, replaceDeltaSnapshot, type DeltaCursorScope, type DeltaPage } from "./offline-delta-sync";

vi.mock("./offline-workspace-db", () => ({
  openOfflineWorkspaceDatabase: vi.fn(),
  openLegacyOfflineDatabaseIfPresent: vi.fn(async () => null),
}));

const scope: DeltaCursorScope = { userId: 1, tenantId: 2, siteId: 3, entityType: "subscribers" };
const other = { ...scope, userId: 9 };
type Row = Record<string, unknown>;
const scopeKey = (s: DeltaCursorScope) => [s.userId, s.tenantId, s.siteId, s.entityType].join(":");
const cursorKey = (s: DeltaCursorScope) => [s.userId, s.tenantId, s.siteId, s.entityType];
const entity = (s: DeltaCursorScope, id: number) => ({
  ...s, scopeKey: scopeKey(s), entityId: String(id),
  rowData: { id, tenantId: s.tenantId, siteId: s.siteId }, updatedAt: 1,
});
const protectedStores = ["operations", "syncMetadata", "claims", "grants", "conflicts", "fieldReadings", "orphanedFieldReadings", "bootstrapState"];

// Deliberately small transactional model: executes the real Delta IndexedDB
// callbacks, enforces object-store scope, and only publishes writes on commit.
// This is not a browser IndexedDB implementation or end-to-end replay test.
function workspace() {
  const data = new Map<string, Map<string, Row>>();
  const seed = (name: string, key: unknown, row: Row) => {
    if (!data.has(name)) data.set(name, new Map());
    data.get(name)!.set(JSON.stringify(key), row);
  };
  for (const s of [scope, other]) {
    seed("cursors", cursorKey(s), { ...s, cursor: "3", updatedAt: 1 });
    seed("entities", [scopeKey(s), "5"], entity(s, 5));
    seed("syncState", cursorKey(s), { ...s, cursor: "3", outcome: "success" });
    for (const [kind, outcome] of [["reading_create", "pending"], ["payment_create", "retryable"], ["expense_create", "conflict"]]) {
      const id = s.userId + ":" + kind;
      seed("operations", id, { ...s, id, clientOperationId: id, kind, status: outcome === "pending" ? "pending" : "failed", payload: { amount: 25, readingValue: 12.5 } });
      seed("syncMetadata", id, { ...s, operationId: id, outcome, attempts: outcome === "pending" ? 0 : 2, dependsOn: ["parent"], nextAttemptAt: 100 });
      seed("claims", id, { ...s, id, clientOperationId: id, numberValue: 17 });
      seed("conflicts", id, { ...s, operationId: id, localPayload: { amount: 25 } });
    }
    for (const name of ["grants", "fieldReadings", "orphanedFieldReadings", "bootstrapState"]) {
      seed(name, s.userId, { ...s, id: s.userId, marker: name });
    }
  }
  let abortOnCommit = false;
  const transactions: string[][] = [];
  const db = {
    close: vi.fn(),
    transaction(names: string | string[], mode: string) {
      const stores = typeof names === "string" ? [names] : [...names];
      transactions.push(stores);
      const staged = new Map(stores.map(name => [name, new Map(data.get(name))]));
      let pending = 0;
      let aborted = false;
      let completed = false;
      const tx: { oncomplete?: () => void; onabort?: () => void; error?: Error; abort: () => void; objectStore: (name: string) => unknown } = {
        abort() {
          if (aborted || completed) return;
          aborted = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore(name) {
          if (!staged.has(name)) throw new Error("store outside transaction: " + name);
          const rows = staged.get(name)!;
          const keyOf = (row: Row) => name === "entities"
            ? [row.scopeKey, row.entityId]
            : [row.userId, row.tenantId, row.siteId, row.entityType];
          return {
            get: (key: unknown) => request(() => rows.get(JSON.stringify(key))),
            getAll: () => request(() => [...rows.values()]),
            put: (row: Row) => request(() => { rows.set(JSON.stringify(keyOf(row)), row); }),
            delete: (key: unknown) => request(() => { rows.delete(JSON.stringify(key)); }),
            index: (index: string) => ({
              getAllKeys: (key: unknown) => request(() => [...rows.entries()]
                .filter(([, row]) => row[index === "byScope" ? "scopeKey" : "userId"] === key)
                .map(([stored]) => JSON.parse(stored))),
            }),
          };
        },
      };
      function request<T>(run: () => T) {
        const req: { result?: T; onsuccess?: () => void } = {};
        pending++;
        queueMicrotask(() => {
          if (aborted) return;
          req.result = run();
          req.onsuccess?.();
          pending--;
          finish();
        });
        return req;
      }
      function finish() {
        if (pending || aborted || completed) return;
        if (abortOnCommit) {
          abortOnCommit = false;
          tx.abort();
          return;
        }
        completed = true;
        if (mode === "readwrite") for (const [name, rows] of staged) data.set(name, rows);
        tx.oncomplete?.();
      }
      return tx;
    },
  };
  vi.mocked(openOfflineWorkspaceDatabase).mockResolvedValue(db as unknown as IDBDatabase);
  return {
    transactions,
    replayInputs: (userId: number) => ({
      items: structuredClone([...data.get("operations")!.values()].filter(row => row.userId === userId)) as unknown as QueuedOfflineWork[],
      metadataByOperationId: new Map(structuredClone([...data.get("syncMetadata")!.values()].filter(row => row.userId === userId))
        .map(row => [String(row.operationId), row as unknown as SyncMetadata] as const)),
    }),
    abortNext: () => { abortOnCommit = true; },
    protectedState: () => structuredClone(protectedStores.map(name => [name, [...data.get(name)!]])),
    cursor: (s: DeltaCursorScope) => data.get("cursors")!.get(JSON.stringify(cursorKey(s)))?.cursor,
    repairVersion: (s: DeltaCursorScope) => data.get("cursors")!.get(JSON.stringify(cursorKey(s)))?.repairVersion,
    ids: (s: DeltaCursorScope) => [...data.get("entities")!.values()].filter(row => row.scopeKey === scopeKey(s)).map(row => row.entityId),
  };
}

const snapshot = [{ id: 6, tenantId: 2, siteId: 3 }];
const reset: DeltaPage = {
  status: "reset_required", entity_type: "subscribers", current_cursor: "20",
  retained_from_cursor: "10", snapshot_cursor: "20", through_cursor: "20",
  next_cursor: null, has_more: false, changes: [],
};
const terminal: DeltaPage = { ...reset, status: "ok", snapshot_cursor: null, next_cursor: "20" };

describe("Delta recovery preserves canonical Outbox stores", () => {
  beforeEach(() => vi.stubGlobal("IDBKeyRange", { only: (key: unknown) => key }));
  afterEach(() => vi.unstubAllGlobals());

  it("replaces the scoped snapshot through the real storage adapter without touching pending, retry or conflict records", async () => {
    const db = workspace();
    const before = db.protectedState();
    const pull = vi.fn().mockResolvedValueOnce(reset).mockResolvedValueOnce(terminal);
    await expect(pullDeltaPages({ scope, afterCursor: "3", pull, rebuildSnapshot: async () => ({ cursor: "20", rows: snapshot }) }))
      .resolves.toEqual({ cursor: "20", appliedChanges: 0, resetRequired: true });
    expect(db.cursor(scope)).toBe("20");
    expect(db.ids(scope)).toEqual(["6"]);
    expect(db.cursor(other)).toBe("3");
    expect(db.ids(other)).toEqual(["5"]);
    expect(db.protectedState()).toEqual(before);
    expect(db.transactions.every(names => names.every(name => !protectedStores.includes(name)))).toBe(true);
  });

  it("resumes preserved intents after reset with stable operation IDs and without replaying a conflict", async () => {
    const db = workspace();
    const before = db.protectedState();
    const pull = vi.fn().mockResolvedValueOnce(reset).mockResolvedValueOnce(terminal);
    await pullDeltaPages({ scope, afterCursor: "3", pull, rebuildSnapshot: async () => ({ cursor: "20", rows: snapshot }) });
    expect(db.protectedState()).toEqual(before);
    const restored = db.replayInputs(scope.userId);
    const calls: string[] = [];
    const committed = new Set<string>();
    const completedIds = new Set(["parent"]);
    const first = await executeReadyOperations({
      ...restored, completedIds, now: 100, random: () => 0.5,
      transport: async operation => {
        const key = operation.clientOperationId;
        calls.push(key);
        committed.add(key);
        if (operation.kind === "payment_create") throw new Error("synthetic lost response");
        return { outcome: "applied" };
      },
    });
    expect(calls.sort()).toEqual(["1:payment_create", "1:reading_create"]);
    const payment = first.find(result => result.item.kind === "payment_create")!;
    expect(payment.outcome).toBe("retryable");
    expect(payment.metadata.attempts).toBe(3);
    expect(first.find(result => result.item.kind === "expense_create")?.outcome).toBe("conflict");
    // Model a restart with persisted executor outcomes; the fake transport
    // simulates server idempotency, not an actual financial RPC.
    const resumedMetadata = new Map(first.map(result => [result.item.clientOperationId, result.metadata]));
    const replay = vi.fn(async (operation: QueuedOfflineWork) => {
      expect(committed.has(operation.clientOperationId)).toBe(true);
      expect(operation.payload).toEqual(payment.item.payload);
      return { outcome: "already_applied" as const };
    });
    const resumed = await executeReadyOperations({
      items: restored.items, metadataByOperationId: resumedMetadata,
      completedIds, transport: replay, now: payment.metadata.nextAttemptAt,
    });
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay.mock.calls[0][0].clientOperationId).toBe("1:payment_create");
    expect(resumed.find(result => result.item.kind === "payment_create")?.outcome).toBe("already_applied");
    expect(db.cursor(scope)).toBe("20");
    expect(db.protectedState()).toEqual(before);
  });

  it("rolls back an interrupted snapshot transaction and retries without changing Outbox identity or metadata", async () => {
    const db = workspace();
    const before = db.protectedState();
    db.abortNext();
    await expect(replaceDeltaSnapshot(scope, snapshot, "20")).rejects.toThrow();
    expect(db.cursor(scope)).toBe("3");
    expect(db.ids(scope)).toEqual(["5"]);
    expect(db.protectedState()).toEqual(before);
    await replaceDeltaSnapshot(scope, snapshot, "20");
    expect(db.cursor(scope)).toBe("20");
    expect(db.ids(scope)).toEqual(["6"]);
    expect(db.protectedState()).toEqual(before);
  });

  it("rejects a late reset after identity changes and preserves operations during old-user Delta cleanup", async () => {
    const db = workspace();
    const before = db.protectedState();
    let active = true;
    await expect(pullDeltaPages({
      scope, afterCursor: "3", pull: async () => reset, isCurrent: () => active,
      rebuildSnapshot: async () => { active = false; return { cursor: "20", rows: snapshot }; },
    })).rejects.toMatchObject({ name: "PowerHubDeltaSyncRunSupersededError" });
    expect(db.cursor(scope)).toBe("3");
    expect(db.ids(scope)).toEqual(["5"]);
    await clearDeltaSyncDataForUser(scope.userId);
    expect(db.cursor(scope)).toBeUndefined();
    expect(db.ids(scope)).toEqual([]);
    expect(db.cursor(other)).toBe("3");
    expect(db.ids(other)).toEqual(["5"]);
    expect(db.protectedState()).toEqual(before);
    expect(db.transactions.every(names => names.every(name => !protectedStores.includes(name)))).toBe(true);
  });
});


describe("Versioned repair checkpoint preserves Outbox and unrelated scope", () => {
  beforeEach(() => vi.stubGlobal("IDBKeyRange", { only: (key: unknown) => key }));
  afterEach(() => vi.unstubAllGlobals());
  const repairScope: DeltaCursorScope = { ...scope, entityType: "maintenance_work_order_parts:42" };
  const part = { id: 6, tenantId: 2, siteId: 3, workOrderId: 42 };
  const terminalAt = (cursor: string): DeltaPage => ({
    ...terminal, entity_type: repairScope.entityType, current_cursor: cursor,
    retained_from_cursor: "0", through_cursor: cursor, next_cursor: cursor,
  });

  it("atomically rolls back entities, cursor and repair version on storage abort", async () => {
    const db = workspace();
    const before = db.protectedState();
    await replaceDeltaSnapshot(repairScope, [part], "3", 1, undefined, 1);
    db.abortNext();
    await expect(replaceDeltaSnapshot(repairScope, [{ ...part, id: 7 }], "4", 2, undefined, 2)).rejects.toThrow();
    expect(db.cursor(repairScope)).toBe("3");
    expect(db.repairVersion(repairScope)).toBe(1);
    expect(db.ids(repairScope)).toEqual(["6"]);
    expect(db.protectedState()).toEqual(before);
    await replaceDeltaSnapshot(repairScope, [{ ...part, id: 7 }], "4", 3, undefined, 2);
    expect(db.repairVersion(repairScope)).toBe(2);
    expect(db.ids(repairScope)).toEqual(["7"]);
    await expect(replaceDeltaSnapshot(repairScope, [part], "4", 4, undefined, 1)).rejects.toThrow(/newer Delta repair/);
    expect(db.repairVersion(repairScope)).toBe(2);
    expect(db.ids(repairScope)).toEqual(["7"]);
    expect(db.cursor(scope)).toBe("3");
    expect(db.ids(other)).toEqual(["5"]);
    expect(db.protectedState()).toEqual(before);
    expect(db.transactions.every(names => names.every(name => !protectedStores.includes(name)))).toBe(true);
  });

  it("resumes catch-up after snapshot commit and preserves the version across ordinary pages", async () => {
    const db = workspace();
    const before = db.protectedState();
    const rebuildSnapshot = vi.fn(async () => ({ cursor: "3", rows: [part] }));
    const pull = vi.fn()
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce({ ...terminalAt("4"), changes: [{
        cursor: "4", entity_type: repairScope.entityType, entity_id: "6", operation: "upsert",
        row_data: { ...part, itemName: "updated" }, changed_at: "2026-11-27T00:00:00Z",
      }] });
    const input = { scope: repairScope, afterCursor: null, repairSnapshot: true, repairVersion: 1, pull, rebuildSnapshot };
    await expect(pullDeltaPages(input)).rejects.toThrow("network lost");
    expect(db.cursor(repairScope)).toBe("3");
    expect(db.repairVersion(repairScope)).toBe(1);
    await pullDeltaPages(input);
    expect(rebuildSnapshot).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenLastCalledWith({ afterCursor: "3", throughCursor: null, pageSize: 200 });
    expect(db.cursor(repairScope)).toBe("4");
    expect(db.repairVersion(repairScope)).toBe(1);
    expect(db.protectedState()).toEqual(before);
    expect(db.cursor(scope)).toBe("3");
    expect(db.ids(other)).toEqual(["5"]);
    expect(db.transactions.every(names => names.every(name => !protectedStores.includes(name)))).toBe(true);
  });
});
