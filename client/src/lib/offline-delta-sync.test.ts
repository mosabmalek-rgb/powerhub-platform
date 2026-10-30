import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDeltaChanges,
  assertDeltaRowWithinScope,
  compareDeltaCursors,
  compareMaintenanceWorkOrderNewestFirst,
  limitDeltaEntityRows,
  isBoundedDeltaEntityType,
  isDeltaSyncRunCurrent,
  pullDeltaPages,
  withDeltaSyncLock,
  type DeltaPage,
  type DeltaSyncStorage,
  type DeltaCursorScope,
} from "./offline-delta-sync";
import { persistOfflineQueryForDeltaSync } from "./offline-query-cache";

const scope: DeltaCursorScope = { userId: 1, tenantId: 1, siteId: 7, entityType: "subscribers" };

afterEach(() => { vi.unstubAllGlobals(); });
const change = (cursor: string, entityId: string, operation: "upsert" | "delete", row_data: Record<string, unknown> | null) => ({
  cursor, entity_type: "subscribers" as const, entity_id: entityId, operation, row_data, changed_at: "2026-10-24T10:00:00Z",
});
const page = (overrides: Partial<DeltaPage> = {}): DeltaPage => ({
  status: "ok", entity_type: "subscribers", current_cursor: "3", retained_from_cursor: "0",
  snapshot_cursor: null, through_cursor: "3", next_cursor: "3", has_more: false, changes: [], ...overrides,
});


function installCacheWriteAbortMock() {
  let transactionCount = 0;
  const database = {
    objectStoreNames: { contains: (_name: string) => true },
    createObjectStore: vi.fn(),
    close: vi.fn(),
    transaction: vi.fn(() => {
      transactionCount += 1;
      const shouldAbort = transactionCount === 1;
      const transaction: Record<string, unknown> = {
        objectStore: () => ({
          put: vi.fn(() => {
            const request: Record<string, unknown> = {};
            queueMicrotask(() => {
              (request.onsuccess as (() => void) | undefined)?.();
              queueMicrotask(() => {
                const handler = shouldAbort ? transaction.onabort : transaction.oncomplete;
                (handler as (() => void) | undefined)?.();
              });
            });
            return request;
          }),
        }),
      };
      return transaction;
    }),
  };
  vi.stubGlobal("indexedDB", {
    open: vi.fn(() => {
      const request: Record<string, unknown> = { result: database };
      queueMicrotask(() => {
        (request.onupgradeneeded as (() => void) | undefined)?.();
        (request.onsuccess as (() => void) | undefined)?.();
      });
      return request;
    }),
  } as unknown as IDBFactory);
  return { writeAttempts: () => transactionCount };
}

const deltaCacheQuery = {
  queryKey: ["powerhub", "subscribers", "list", { siteId: 7 }],
  state: {
    status: "success",
    data: [{ id: 7, tenantId: 1, siteId: 7, name: "Recovered" }],
    dataUpdatedAt: 1_000,
  },
} as never;

function memoryStorage(initialCursor = "0", initialRows: Record<string, unknown>[] = []): DeltaSyncStorage {
  let cursor = initialCursor;
  let rows = new Map<string, Record<string, unknown>>(initialRows.map(row => [String(row.id), row]));
  const retainBoundedRows = (entityType: DeltaCursorScope["entityType"]) => {
    const bounded = limitDeltaEntityRows(entityType, [...rows].map(([entityId, rowData]) => ({
      ...rowData,
      id: rowData.id ?? entityId,
    })));
    rows = new Map(bounded.map(row => [String(row.id), row]));
  };
  return {
    getCursor: async () => cursor,
    listEntities: async (requestedScope) => [...rows].map(([entityId, rowData]) => ({ ...requestedScope, entityId, rowData, updatedAt: 1 })),
    commitPage: async (targetScope, p, next) => {
      if (BigInt(next) < BigInt(cursor)) throw new Error("stale cursor");
      if (BigInt(next) === BigInt(cursor)) return;
      for (const c of p.changes) {
        if (c.operation === "delete") rows.delete(c.entity_id);
        else if (c.row_data) rows.set(c.entity_id, c.row_data);
      }
      retainBoundedRows(targetScope.entityType);
      cursor = next;
    },
    replaceSnapshot: async (targetScope, snapshot, next) => {
      if (BigInt(next) < BigInt(cursor)) throw new Error("stale snapshot");
      rows = new Map(limitDeltaEntityRows(targetScope.entityType, snapshot).map(row => [String(row.id), row]));
      cursor = next;
    },
    clearUser: async () => { cursor = "0"; rows.clear(); },
  };
}

describe("Delta run identity guard", () => {
  it("allows writes only while the run owner is still the active authenticated user", () => {
    expect(isDeltaSyncRunCurrent(7, 7, false)).toBe(true);
    expect(isDeltaSyncRunCurrent(7, 8, false)).toBe(false);
    expect(isDeltaSyncRunCurrent(7, null, false)).toBe(false);
    expect(isDeltaSyncRunCurrent(7, 7, true)).toBe(false);
    expect(isDeltaSyncRunCurrent(0, 0, false)).toBe(false);
  });

  it("discards a late page after the authenticated owner changes without applying rows or advancing its cursor", async () => {
    const storage = memoryStorage("3");
    let active = true;
    let resolvePull!: (value: DeltaPage<Record<string, unknown>>) => void;
    const pendingPull = new Promise<DeltaPage<Record<string, unknown>>>((resolve) => {
      resolvePull = resolve;
    });
    const pull = vi.fn(() => pendingPull);
    const applyPage = vi.fn(async () => undefined);
    const pendingRun = pullDeltaPages({
      scope,
      storage,
      afterCursor: "3",
      pull,
      applyPage,
      rebuildSnapshot: async (cursor) => ({ cursor, rows: [] }),
      isCurrent: () => isDeltaSyncRunCurrent(7, active ? 7 : 8, false),
    });

    active = false;
    resolvePull(page({
      current_cursor: "4",
      through_cursor: "4",
      next_cursor: "4",
      changes: [change("4", "99", "upsert", { id: 99, tenantId: 1, siteId: 7 })],
    }));

    await expect(pendingRun).rejects.toMatchObject({
      name: "PowerHubDeltaSyncRunSupersededError",
    });
    expect(applyPage).not.toHaveBeenCalled();
    expect(await storage.getCursor(scope)).toBe("3");
    expect(await storage.listEntities(scope)).toEqual([]);
  });
});

describe("Delta row scope validation", () => {
  const scoped = { tenantId: 1, siteId: 7 };
  it("accepts correctly scoped rows for every operational entity", () => {
    const rows: Array<[import("./offline-delta-sync").DeltaEntityType, Record<string, unknown>]> = [
      ["sites", { id: 7, tenantId: 1 }],
      ["subscribers", { id: 11, tenantId: 1, siteId: 7 }],
      ["generators", { id: 12, tenantId: 1, siteId: 7 }],
      ["readings", { id: 13, tenantId: 1, siteId: 7 }],
      ["tariffs", { id: 14, tenantId: 1, siteId: 7 }],
      ["invoices", { id: 15, tenantId: 1, siteId: 7 }],
      ["payments", {
        id: 16, tenantId: 1, siteId: 7,
        payment: { id: 16, tenantId: 1, siteId: 7 },
        subscriber: { id: 11, tenantId: 1, siteId: 7 },
      }],
      ["expenses", { id: 17, tenantId: 1, siteId: 7 }],
    ];
    for (const [entityType, row] of rows) {
      expect(() => assertDeltaRowWithinScope(entityType, row, scoped), entityType).not.toThrow();
    }
  });

  it("rejects cross-tenant, cross-site and wrong-site rows, not only invoices", () => {
    for (const entityType of ["subscribers", "generators", "readings", "tariffs", "invoices", "payments", "expenses"] as const) {
      expect(() => assertDeltaRowWithinScope(entityType, { id: 1, tenantId: 2, siteId: 7 }, scoped), entityType)
        .toThrow(/خارج نطاق المستأجر أو الفرع/);
      expect(() => assertDeltaRowWithinScope(entityType, { id: 1, tenantId: 1, siteId: 8 }, scoped), entityType)
        .toThrow(/خارج نطاق المستأجر أو الفرع/);
    }
    expect(() => assertDeltaRowWithinScope("sites", { id: 8, tenantId: 1 }, scoped))
      .toThrow(/خارج نطاق المستأجر أو الفرع/);
  });

  it("rejects maintenance-part rows from a different work-order partition", () => {
    const partsEntity = "maintenance_work_order_parts:77" as const;
    expect(() => assertDeltaRowWithinScope(partsEntity, {
      id: 5, tenantId: 1, siteId: 7, work_order_id: 77,
    }, scoped)).not.toThrow();
    expect(() => assertDeltaRowWithinScope(partsEntity, {
      id: 5, tenantId: 1, siteId: 7, work_order_id: 78,
    }, scoped)).toThrow(/خارج نطاق أمر الصيانة/);
  });

  it("rejects readings without resolved site scope", () => {
    expect(() => assertDeltaRowWithinScope("readings", { id:700, tenantId:1, subscriberId:101 }, scoped))
      .toThrow(/خارج نطاق المستأجر أو الفرع/);
    expect(() => assertDeltaRowWithinScope("readings", { id:700, tenantId:1, siteId:7, subscriberId:101 }, scoped)).not.toThrow();
  });

  it("validates joined payment and reading relations independently", () => {
    expect(() => assertDeltaRowWithinScope("payments", {
      id: 16, tenantId: 1, siteId: 7,
      payment: { id: 16, tenantId: 1, siteId: 8 },
      subscriber: { id: 11, tenantId: 1, siteId: 7 },
    }, scoped)).toThrow(/العلاقة payment/);
    expect(() => assertDeltaRowWithinScope("payments", {
      id: 16, tenantId: 1, siteId: 7,
      payment: { id: 16, tenantId: 1, siteId: 7 },
      subscriber: { id: 11, tenantId: 2, siteId: 7 },
    }, scoped)).toThrow(/العلاقة subscriber/);
    expect(() => assertDeltaRowWithinScope("readings", {
      id: 13, tenantId: 1, siteId: 7,
      subscriber: { id: 11, tenantId: 1, siteId: 8 },
    }, scoped)).toThrow(/العلاقة subscriber/);
  });
});

describe("maintenance work-order Delta ordering", () => {
  it("matches server ordering with reported_at fallback to created_at and stable descending IDs", () => {
    const olderCreated = { id: 21, created_at: "2026-10-27T10:00:00Z" };
    const newerReported = { id: 20, reported_at: "2026-10-28T10:00:00Z", created_at: "2026-10-20T10:00:00Z" };
    const sameTimeHigherId = { id: 22, reported_at: "2026-10-28T10:00:00Z" };
    expect(compareMaintenanceWorkOrderNewestFirst(newerReported, olderCreated)).toBeLessThan(0);
    expect(compareMaintenanceWorkOrderNewestFirst(sameTimeHigherId, newerReported)).toBeLessThan(0);
    expect(compareMaintenanceWorkOrderNewestFirst(olderCreated, newerReported)).toBeGreaterThan(0);
  });
});

describe("bounded Delta sidecar retention policy", () => {
  it("prunes bounded fuel and maintenance entities but never truncates a per-order parts partition", () => {
    for (const entityType of [
      "fuel_readings", "maintenance_preventive_plans", "fuel_events", "maintenance_work_orders",
    ] as const) {
      expect(isBoundedDeltaEntityType(entityType), entityType).toBe(true);
    }
    expect(isBoundedDeltaEntityType("maintenance_work_order_parts:77")).toBe(false);
    expect(isBoundedDeltaEntityType("subscribers")).toBe(false);
  });
});

describe("offline delta sync", () => {
  it("serializes all shared projections for one user while keeping other users independent", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });

    const first = withDeltaSyncLock(scope, async () => {
      order.push("first:start");
      signalFirstStarted();
      await firstGate;
      order.push("first:end");
      return "first";
    }, null);
    await firstStarted;

    const second = withDeltaSyncLock(scope, async () => {
      order.push("second:start");
      order.push("second:end");
      return "second";
    }, null);
    const independent = await withDeltaSyncLock({ ...scope, userId: 2, entityType: "invoices" }, async () => {
      order.push("independent");
      return "independent";
    }, null);

    expect(independent).toBe("independent");
    expect(order).toEqual(["first:start", "independent"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual([
      "first:start", "independent", "first:end", "second:start", "second:end",
    ]);
  });

  it("compares bigint cursors without precision loss", () => {
    expect(compareDeltaCursors("9007199254740993", "9007199254740992")).toBe(1);
    expect(() => compareDeltaCursors("0002", "2")).toThrow(/مؤشر المزامنة/);
  });

  it("applies ordered upserts and tombstones without duplicating entity ids", () => {
    const current = [{ id: 1, name: "old" }, { id: 2, name: "keep" }];
    expect(applyDeltaChanges(current, [
      change("1", "1", "upsert", { id: 1, name: "new" }),
      change("2", "3", "upsert", { id: 3, name: "added" }),
      change("3", "2", "delete", null),
    ])).toEqual([{ id: 1, name: "new" }, { id: 3, name: "added" }]);
  });

  it("rejects unordered pages and mismatched row identities", () => {
    expect(() => applyDeltaChanges([], [
      change("2", "1", "delete", null), change("1", "2", "delete", null),
    ])).toThrow(/ترتيب تغييرات/);
    expect(() => applyDeltaChanges([], [change("1", "1", "upsert", { id: 2 })])).toThrow(/لا تطابق/);
  });

  it("holds one through-cursor across pages and commits page changes before reporting success", async () => {
    const storage = memoryStorage();
    const pull = vi.fn()
      .mockResolvedValueOnce(page({ through_cursor: "9", current_cursor: "9", next_cursor: "4", has_more: true, changes: [change("4", "1", "upsert", { id: 1, name: "A" })] }))
      .mockResolvedValueOnce(page({ through_cursor: "9", current_cursor: "9", next_cursor: "9", has_more: false, changes: [change("9", "2", "delete", null)] }));
    const result = await pullDeltaPages({ scope, storage, afterCursor: "3", pull, rebuildSnapshot: async cursor => ({ cursor, rows: [] }) });
    expect(pull.mock.calls).toEqual([
      [{ afterCursor: "3", throughCursor: null, pageSize: 200 }],
      [{ afterCursor: "4", throughCursor: "9", pageSize: 200 }],
    ]);
    expect((await storage.listEntities(scope)).map(x => x.rowData)).toEqual([{ id: 1, name: "A" }]);
    expect(await storage.getCursor(scope)).toBe("9");
    expect(result).toEqual({ cursor: "9", appliedChanges: 2, resetRequired: false });
  });


  it("keeps the durable cursor unchanged when IndexedDB aborts after a Delta-cache put succeeds, then retries the page", async () => {
    const storage = memoryStorage("3");
    const indexedDb = installCacheWriteAbortMock();
    const expectedPage = page({
      current_cursor: "4", through_cursor: "4", next_cursor: "4",
      changes: [change("4", "7", "upsert", { id: 7, name: "Recovered" })],
    });
    const pull = vi.fn(async () => expectedPage);
    const applyPage = async () => persistOfflineQueryForDeltaSync(deltaCacheQuery, "1", 1_000);
    const rebuildSnapshot = async (cursor: string) => ({ cursor, rows: [] });

    // The IDB request succeeds, but transaction.onabort fires afterward. The
    // required write must reject rather than inherit best-effort cache semantics.
    await expect(pullDeltaPages({
      scope, storage, afterCursor: "3", pull, applyPage, rebuildSnapshot,
    })).rejects.toThrow(/حفظ نسخة الكاش المطلوبة قبل تثبيت مؤشر Delta/);
    expect(await storage.getCursor(scope)).toBe("3");
    expect(await storage.listEntities(scope)).toEqual([]);
    expect(indexedDb.writeAttempts()).toBe(1);

    // The old cursor makes retry replay the exact same server page safely.
    const result = await pullDeltaPages({
      scope, storage, afterCursor: "3", pull, applyPage, rebuildSnapshot,
    });
    expect(pull).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ cursor: "4", appliedChanges: 1, resetRequired: false });
    expect(await storage.getCursor(scope)).toBe("4");
    expect((await storage.listEntities(scope)).map(row => row.rowData)).toEqual([{ id: 7, name: "Recovered" }]);
    expect(indexedDb.writeAttempts()).toBe(2);
  });

  it("keeps the Delta cursor and entity snapshot unchanged when the page commit aborts, then replays the same page", async () => {
    const durable = memoryStorage("3");
    let commitAttempts = 0;
    const storage: DeltaSyncStorage = {
      getCursor: (...args) => durable.getCursor(...args),
      listEntities: (...args) => durable.listEntities(...args),
      commitPage: async (targetScope, deltaPage, nextCursor) => {
        commitAttempts += 1;
        // Model an IndexedDB readwrite transaction that aborts before commit:
        // neither entity mutations nor its cursor become durable.
        if (commitAttempts === 1) throw new Error("Injected Delta IndexedDB transaction abort");
        await durable.commitPage(targetScope, deltaPage, nextCursor);
      },
      replaceSnapshot: (...args) => durable.replaceSnapshot(...args),
      clearUser: (...args) => durable.clearUser(...args),
    };
    const expectedPage = page({
      current_cursor: "4",
      through_cursor: "4",
      next_cursor: "4",
      changes: [change("4", "7", "upsert", { id: 7, tenantId: 1, siteId: 7, name: "Recovered" })],
    });
    const pull = vi.fn(async () => expectedPage);
    const input = {
      scope,
      storage,
      afterCursor: "3",
      pull,
      applyPage: async () => undefined,
      rebuildSnapshot: async (cursor: string) => ({ cursor, rows: [] }),
    };

    await expect(pullDeltaPages(input)).rejects.toThrow(/Injected Delta IndexedDB transaction abort/);
    expect(await storage.getCursor(scope)).toBe("3");
    expect(await storage.listEntities(scope)).toEqual([]);
    expect(commitAttempts).toBe(1);

    const result = await pullDeltaPages(input);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ cursor: "4", appliedChanges: 1, resetRequired: false });
    expect(await storage.getCursor(scope)).toBe("4");
    expect((await storage.listEntities(scope)).map(row => row.rowData)).toEqual([
      { id: 7, tenantId: 1, siteId: 7, name: "Recovered" },
    ]);
    expect(commitAttempts).toBe(2);
  });

  it("rebuilds and atomically checkpoints when server retention requires a snapshot", async () => {
    const storage = memoryStorage();
    const pull = vi.fn()
      .mockResolvedValueOnce(page({ status: "reset_required", snapshot_cursor: "20", current_cursor: "20", through_cursor: "20", next_cursor: null, changes: [] }))
      .mockResolvedValueOnce(page({ current_cursor: "22", through_cursor: "22", next_cursor: "22", changes: [change("22", "7", "upsert", { id: 7 })] }));
    const result = await pullDeltaPages({
      scope, storage, afterCursor: null, pull,
      rebuildSnapshot: async () => ({ cursor: "21", rows: [{ id: 6, name: "snapshot" }] }),
    });
    expect(pull.mock.calls[1][0]).toEqual({ afterCursor: "21", throughCursor: null, pageSize: 200 });
    expect(await storage.getCursor(scope)).toBe("22");
    expect((await storage.listEntities(scope)).map(x => x.entityId).sort()).toEqual(["6", "7"]);
    expect(result).toEqual({ cursor: "22", appliedChanges: 1, resetRequired: true });
  });

  it("fails closed if the server changes the page boundary", async () => {
    const pull = vi.fn()
      .mockResolvedValueOnce(page({ through_cursor: "9", current_cursor: "9", next_cursor: "4", has_more: true, changes: [change("4", "1", "delete", null)] }))
      .mockResolvedValueOnce(page({ through_cursor: "10", current_cursor: "10", next_cursor: "10", has_more: false }));
    await expect(pullDeltaPages({ scope, storage: memoryStorage(), afterCursor: "3", pull, rebuildSnapshot: async cursor => ({ cursor, rows: [] }) }))
      .rejects.toThrow(/تغيّر حد المزامنة/);
  });

  it("rejects malformed terminal cursors and a page whose entity type differs from the requested scope", async () => {
    await expect(pullDeltaPages({
      scope, storage: memoryStorage(), afterCursor: null,
      pull: async () => page({ next_cursor: "not-a-cursor" }), rebuildSnapshot: async cursor => ({ cursor, rows: [] }),
    })).rejects.toThrow(/مؤشر المزامنة/);
    await expect(pullDeltaPages({
      scope, storage: memoryStorage(), afterCursor: null,
      pull: async () => page({ entity_type: "generators" }), rebuildSnapshot: async cursor => ({ cursor, rows: [] }),
    })).rejects.toThrow(/لا تطابق نوع البيانات/);
  });

  it("keeps the local stock-movement snapshot and incremental sidecar bounded to the newest 500 rows", async () => {
    const movementScope: DeltaCursorScope = {
      ...scope,
      entityType: "inventory_stock_movements",
    };
    const storage = memoryStorage();
    const movementRows = Array.from({ length: 501 }, (_, index) => {
      const id = index + 1;
      return {
        id,
        tenantId: movementScope.tenantId,
        siteId: movementScope.siteId,
        occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
      };
    });

    await storage.replaceSnapshot(movementScope, movementRows, "10");
    const afterSnapshot = await storage.listEntities(movementScope);
    expect(afterSnapshot).toHaveLength(500);
    expect(afterSnapshot.some((record) => record.entityId === "1")).toBe(false);
    expect(afterSnapshot.some((record) => record.entityId === "2")).toBe(true);
    expect(afterSnapshot.some((record) => record.entityId === "501")).toBe(true);

    const newest = {
      id: 502,
      tenantId: movementScope.tenantId,
      siteId: movementScope.siteId,
      occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 502)).toISOString(),
    };
    const movementPage = page({
      entity_type: "inventory_stock_movements",
      current_cursor: "11",
      through_cursor: "11",
      next_cursor: "11",
      changes: [{
        cursor: "11",
        entity_type: "inventory_stock_movements",
        entity_id: "502",
        operation: "upsert",
        row_data: newest,
        changed_at: newest.occurred_at,
      }],
    });
    await storage.commitPage(movementScope, movementPage, "11");
    const afterDelta = await storage.listEntities(movementScope);
    expect(afterDelta).toHaveLength(500);
    expect(afterDelta.some((record) => record.entityId === "2")).toBe(false);
    expect(afterDelta.some((record) => record.entityId === "3")).toBe(true);
    expect(afterDelta.some((record) => record.entityId === "502")).toBe(true);
    expect(await storage.getCursor(movementScope)).toBe("11");
  });

  it("bounds fuel-fill events and work orders while preserving complete per-order parts", () => {
    const fuelEvents = Array.from({ length: 501 }, (_, index) => {
      const id = index + 1;
      return { id, event_id: id, occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString() };
    });
    const boundedEvents = limitDeltaEntityRows("fuel_events", fuelEvents);
    expect(boundedEvents).toHaveLength(500);
    expect(boundedEvents[0]?.id).toBe(501);
    expect(boundedEvents.some(row => row.id === 1)).toBe(false);

    const orders = Array.from({ length: 201 }, (_, index) => {
      const id = index + 1;
      return { id, work_order_id: id, reported_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString() };
    });
    const boundedOrders = limitDeltaEntityRows("maintenance_work_orders", orders);
    expect(boundedOrders).toHaveLength(200);
    expect(boundedOrders[0]?.id).toBe(201);
    expect(boundedOrders.some(row => row.id === 1)).toBe(false);

    const parts = Array.from({ length: 501 }, (_, index) => ({ id: index + 1, work_order_id: 77 }));
    expect(limitDeltaEntityRows("maintenance_work_order_parts:77", parts)).toHaveLength(501);
  });

  it("keeps the newest 500 fuel readings when pruning the local Delta snapshot", async () => {
    const fuelScope: DeltaCursorScope = { ...scope, entityType: "fuel_readings" };
    const storage = memoryStorage();
    const snapshot = Array.from({ length: 501 }, (_, index) => {
      const id = index + 1;
      return {
        id, reading_id: id, tenantId: fuelScope.tenantId, siteId: fuelScope.siteId,
        recorded_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
      };
    });
    await storage.replaceSnapshot(fuelScope, snapshot, "10");
    const localRows = await storage.listEntities(fuelScope);
    expect(localRows).toHaveLength(500);
    expect(localRows.some(row => row.entityId === "1")).toBe(false);
    expect(localRows.some(row => row.entityId === "2")).toBe(true);
    expect(localRows.some(row => row.entityId === "501")).toBe(true);
    expect(await storage.getCursor(fuelScope)).toBe("10");
  });

  it("caps maintenance-plan Delta retention at 500 rows and prioritizes overdue plans", async () => {
    const maintenanceScope: DeltaCursorScope = { ...scope, entityType: "maintenance_preventive_plans" };
    const storage = memoryStorage();
    const snapshot = Array.from({ length: 501 }, (_, index) => {
      const id = index + 1;
      return {
        id, plan_id: id, tenantId: maintenanceScope.tenantId, siteId: maintenanceScope.siteId,
        alert_type: id === 1 ? "overdue" : "normal",
        next_due_at: new Date(Date.UTC(2027, 0, 1 + index)).toISOString(),
      };
    });
    await storage.replaceSnapshot(maintenanceScope, snapshot, "10");
    const localRows = await storage.listEntities(maintenanceScope);
    expect(localRows).toHaveLength(500);
    expect(localRows.some(row => row.entityId === "1")).toBe(true);
    expect(localRows.some(row => row.entityId === "501")).toBe(false);
    expect(await storage.getCursor(maintenanceScope)).toBe("10");
  });

  it("prunes plans that leave the top 500 and retains the replacement emitted by membership refresh", async () => {
    const maintenanceScope: DeltaCursorScope = { ...scope, entityType: "maintenance_preventive_plans" };
    const snapshot = Array.from({ length: 500 }, (_, index) => {
      const id = index + 1;
      return {
        id, plan_id: id, tenantId: maintenanceScope.tenantId, siteId: maintenanceScope.siteId,
        alert_type: id === 1 ? "overdue" : "normal",
        next_due_at: new Date(Date.UTC(2027, 0, 1 + index)).toISOString(),
      };
    });
    const storage = memoryStorage("10", snapshot);
    const movedOut = {
      id: 1, plan_id: 1, tenantId: maintenanceScope.tenantId, siteId: maintenanceScope.siteId,
      alert_type: "normal",
      next_due_at: "2035-01-01T00:00:00.000Z",
    };
    const replacement = {
      id: 501, plan_id: 501, tenantId: maintenanceScope.tenantId, siteId: maintenanceScope.siteId,
      alert_type: "normal",
      next_due_at: "2028-05-16T00:00:00.000Z",
    };
    await storage.commitPage(maintenanceScope, page({
      entity_type: "maintenance_preventive_plans",
      current_cursor: "12", through_cursor: "12", next_cursor: "12",
      changes: [
        { cursor: "11", entity_type: "maintenance_preventive_plans", entity_id: "1", operation: "upsert", row_data: movedOut, changed_at: "2026-10-29T12:00:00Z" },
        { cursor: "12", entity_type: "maintenance_preventive_plans", entity_id: "501", operation: "upsert", row_data: replacement, changed_at: "2026-10-29T12:00:01Z" },
      ],
    }), "12");
    const localRows = await storage.listEntities(maintenanceScope);
    expect(localRows).toHaveLength(500);
    expect(localRows.some(row => row.entityId === "1")).toBe(false);
    expect(localRows.some(row => row.entityId === "501")).toBe(true);
    expect(await storage.getCursor(maintenanceScope)).toBe("12");
  });

  it("refills the bounded fuel-reading set after a deletion tombstone", async () => {
    const fuelScope: DeltaCursorScope = { ...scope, entityType: "fuel_readings" };
    const snapshot = Array.from({ length: 500 }, (_, index) => {
      const id = index + 2;
      return {
        id, reading_id: id, tenantId: fuelScope.tenantId, siteId: fuelScope.siteId,
        recorded_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
      };
    });
    const storage = memoryStorage("20", snapshot);
    const replacement = {
      id: 1, reading_id: 1, tenantId: fuelScope.tenantId, siteId: fuelScope.siteId,
      recorded_at: "2026-01-01T00:01:00.000Z",
    };
    await storage.commitPage(fuelScope, page({
      entity_type: "fuel_readings",
      current_cursor: "22", through_cursor: "22", next_cursor: "22",
      changes: [
        { cursor: "21", entity_type: "fuel_readings", entity_id: "2", operation: "delete", row_data: null, changed_at: "2026-10-29T12:00:00Z" },
        { cursor: "22", entity_type: "fuel_readings", entity_id: "1", operation: "upsert", row_data: replacement, changed_at: "2026-10-29T12:00:01Z" },
      ],
    }), "22");
    const localRows = await storage.listEntities(fuelScope);
    expect(localRows).toHaveLength(500);
    expect(localRows.some(row => row.entityId === "2")).toBe(false);
    expect(localRows.some(row => row.entityId === "1")).toBe(true);
    expect(await storage.getCursor(fuelScope)).toBe("22");
  });

  it("caps stocktake sidecar retention at the newest 200 rows on snapshots and incremental updates", async () => {
    const stocktakeScope: DeltaCursorScope = { ...scope, entityType: "inventory_stocktakes" };
    const storage = memoryStorage();
    const snapshot = Array.from({ length: 201 }, (_, index) => {
      const id = index + 1;
      return {
        id, stocktake_id: id, tenantId: stocktakeScope.tenantId, siteId: stocktakeScope.siteId,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(), status: "counting",
      };
    });
    await storage.replaceSnapshot(stocktakeScope, snapshot, "10");
    const initial = await storage.listEntities(stocktakeScope);
    expect(initial).toHaveLength(200);
    expect(initial.some(row => row.entityId === "1")).toBe(false);
    expect(initial.some(row => row.entityId === "2")).toBe(true);
    expect(initial.some(row => row.entityId === "201")).toBe(true);
    const newest = {
      id: 202, stocktake_id: 202, tenantId: stocktakeScope.tenantId, siteId: stocktakeScope.siteId,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 202)).toISOString(), status: "counting",
    };
    const nextPage: DeltaPage<Record<string, unknown>> = page({
      entity_type: "inventory_stocktakes", current_cursor: "11", through_cursor: "11", next_cursor: "11",
      changes: [{
        cursor: "11", entity_type: "inventory_stocktakes", entity_id: "202",
        operation: "upsert", row_data: newest, changed_at: newest.created_at,
      }],
    });
    await storage.commitPage(stocktakeScope, nextPage, "11");
    const afterDelta = await storage.listEntities(stocktakeScope);
    expect(afterDelta).toHaveLength(200);
    expect(afterDelta.some(row => row.entityId === "2")).toBe(false);
    expect(afterDelta.some(row => row.entityId === "3")).toBe(true);
    expect(afterDelta.some(row => row.entityId === "202")).toBe(true);
    expect(await storage.getCursor(stocktakeScope)).toBe("11");
  });

  it("caps local purchase-header Delta retention at the newest 200 headers by invoice date", async () => {
    const purchaseScope: DeltaCursorScope = { ...scope, entityType: "inventory_purchase_headers" };
    const storage = memoryStorage();
    const snapshot = Array.from({ length: 201 }, (_, index) => {
      const id = index + 1;
      return {
        id, purchase_id: id, tenantId: purchaseScope.tenantId, siteId: purchaseScope.siteId,
        invoice_date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
        status: "confirmed",
      };
    });
    await storage.replaceSnapshot(purchaseScope, snapshot, "20");
    const initial = await storage.listEntities(purchaseScope);
    expect(initial).toHaveLength(200);
    expect(initial.some(row => row.entityId === "1")).toBe(false);
    expect(initial.some(row => row.entityId === "2")).toBe(true);
    expect(initial.some(row => row.entityId === "201")).toBe(true);
    const newest = {
      id: 202, purchase_id: 202, tenantId: purchaseScope.tenantId, siteId: purchaseScope.siteId,
      invoice_date: "2027-01-01", status: "received",
    };
    const deltaPage: DeltaPage<Record<string, unknown>> = page({
      entity_type: "inventory_purchase_headers", current_cursor: "21", through_cursor: "21", next_cursor: "21",
      changes: [{
        cursor: "21", entity_type: "inventory_purchase_headers", entity_id: "202",
        operation: "upsert", row_data: newest, changed_at: "2027-01-01T00:00:00Z",
      }],
    });
    await storage.commitPage(purchaseScope, deltaPage, "21");
    const afterDelta = await storage.listEntities(purchaseScope);
    expect(afterDelta).toHaveLength(200);
    expect(afterDelta.some(row => row.entityId === "2")).toBe(false);
    expect(afterDelta.some(row => row.entityId === "3")).toBe(true);
    expect(afterDelta.some(row => row.entityId === "202")).toBe(true);
    expect(await storage.getCursor(purchaseScope)).toBe("21");
  });

  it.each(["inventory_purchase_receipt_headers", "inventory_supplier_return_headers"] as const)(
    "bounds %s local history at 200 rows across snapshots and Delta pages",
    async (entityType) => {
      const historyScope: DeltaCursorScope = { ...scope, entityType };
      const storage = memoryStorage();
      const snapshot = Array.from({ length: 201 }, (_, index) => {
        const id = index + 1;
        const day = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
        return {
          id, tenantId: historyScope.tenantId, siteId: historyScope.siteId,
          receipt_id: entityType === "inventory_purchase_receipt_headers" ? id : undefined,
          return_id: entityType === "inventory_supplier_return_headers" ? id : undefined,
          receipt_date: entityType === "inventory_purchase_receipt_headers" ? day : undefined,
          return_date: entityType === "inventory_supplier_return_headers" ? day : undefined,
        };
      });
      await storage.replaceSnapshot(historyScope, snapshot, "40");
      const initial = await storage.listEntities(historyScope);
      expect(initial).toHaveLength(200);
      expect(initial.some(row => row.entityId === "1")).toBe(false);
      expect(initial.some(row => row.entityId === "201")).toBe(true);
      const nextPage: DeltaPage<Record<string, unknown>> = page({
        entity_type: entityType, current_cursor: "41", through_cursor: "41", next_cursor: "41",
        changes: [{
          cursor: "41", entity_type: entityType, entity_id: "202", operation: "upsert",
          row_data: { id: 202, tenantId: historyScope.tenantId, siteId: historyScope.siteId,
            receipt_id: entityType === "inventory_purchase_receipt_headers" ? 202 : undefined,
            return_id: entityType === "inventory_supplier_return_headers" ? 202 : undefined,
            receipt_date: entityType === "inventory_purchase_receipt_headers" ? "2027-01-01" : undefined,
            return_date: entityType === "inventory_supplier_return_headers" ? "2027-01-01" : undefined },
          changed_at: "2027-01-01T00:00:00Z",
        }],
      });
      await storage.commitPage(historyScope, nextPage, "41");
      const afterDelta = await storage.listEntities(historyScope);
      expect(afterDelta).toHaveLength(200);
      expect(afterDelta.some(row => row.entityId === "202")).toBe(true);
      expect(await storage.getCursor(historyScope)).toBe("41");
    },
  );

  it("does not let an older snapshot replace a newer local cursor", async () => {
    const storage = memoryStorage();
    await storage.replaceSnapshot(scope, [{ id: 1, name: "new" }], "10");
    await expect(storage.replaceSnapshot(scope, [{ id: 1, name: "stale" }], "9")).rejects.toThrow(/stale snapshot/);
    expect((await storage.listEntities(scope))[0].rowData.name).toBe("new");
  });
});
