import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDeltaChanges,
  assertDeltaRowWithinScope,
  compareDeltaCursors,
  pullDeltaPages,
  type DeltaPage,
  type DeltaSyncStorage,
  type DeltaCursorScope,
} from "./offline-delta-sync";

const scope: DeltaCursorScope = { userId: 1, tenantId: 1, siteId: 7, entityType: "subscribers" };
const change = (cursor: string, entityId: string, operation: "upsert" | "delete", row_data: Record<string, unknown> | null) => ({
  cursor, entity_type: "subscribers" as const, entity_id: entityId, operation, row_data, changed_at: "2026-10-24T10:00:00Z",
});
const page = (overrides: Partial<DeltaPage> = {}): DeltaPage => ({
  status: "ok", entity_type: "subscribers", current_cursor: "3", retained_from_cursor: "0",
  snapshot_cursor: null, through_cursor: "3", next_cursor: "3", has_more: false, changes: [], ...overrides,
});

function memoryStorage(initialCursor = "0", initialRows: Record<string, unknown>[] = []): DeltaSyncStorage {
  let cursor = initialCursor;
  let rows = new Map<string, Record<string, unknown>>(initialRows.map(row => [String(row.id), row]));
  return {
    getCursor: async () => cursor,
    listEntities: async () => [...rows].map(([entityId, rowData]) => ({ ...scope, entityId, rowData, updatedAt: 1 })),
    commitPage: async (_scope, p, next) => {
      if (BigInt(next) < BigInt(cursor)) throw new Error("stale cursor");
      if (BigInt(next) === BigInt(cursor)) return;
      for (const c of p.changes) {
        if (c.operation === "delete") rows.delete(c.entity_id);
        else if (c.row_data) rows.set(c.entity_id, c.row_data);
      }
      cursor = next;
    },
    replaceSnapshot: async (_scope, snapshot, next) => {
      if (BigInt(next) < BigInt(cursor)) throw new Error("stale snapshot");
      rows = new Map(snapshot.map(row => [String(row.id), row]));
      cursor = next;
    },
    clearUser: async () => { cursor = "0"; rows.clear(); },
  };
}

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

describe("offline delta sync", () => {
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


  it("does not advance the durable cursor when applying a page to the live cache fails", async () => {
    const storage = memoryStorage("3");
    const expectedPage = page({
      current_cursor: "4", through_cursor: "4", next_cursor: "4",
      changes: [change("4", "7", "upsert", { id: 7, name: "Recovered" })],
    });
    const pull = async () => expectedPage;
    await expect(pullDeltaPages({
      scope, storage, afterCursor: "3", pull,
      applyPage: async () => { throw new Error("simulated cache persistence failure"); },
      rebuildSnapshot: async cursor => ({ cursor, rows: [] }),
    })).rejects.toThrow(/simulated cache persistence failure/);
    expect(await storage.getCursor(scope)).toBe("3");
    expect(await storage.listEntities(scope)).toEqual([]);

    const result = await pullDeltaPages({
      scope, storage, afterCursor: "3", pull,
      applyPage: async () => {},
      rebuildSnapshot: async cursor => ({ cursor, rows: [] }),
    });
    expect(result.cursor).toBe("4");
    expect(await storage.getCursor(scope)).toBe("4");
    expect((await storage.listEntities(scope)).map(row => row.rowData)).toEqual([{ id: 7, name: "Recovered" }]);
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

  it("does not let an older snapshot replace a newer local cursor", async () => {
    const storage = memoryStorage();
    await storage.replaceSnapshot(scope, [{ id: 1, name: "new" }], "10");
    await expect(storage.replaceSnapshot(scope, [{ id: 1, name: "stale" }], "9")).rejects.toThrow(/stale snapshot/);
    expect((await storage.listEntities(scope))[0].rowData.name).toBe("new");
  });
});
