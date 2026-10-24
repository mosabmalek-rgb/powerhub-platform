import { describe, expect, it, vi } from "vitest";
import { applyDeltaChanges, compareDeltaCursors, pullDeltaPages, type DeltaPage } from "./offline-delta-sync";

const change = (cursor: string, entityId: string, operation: "upsert" | "delete", row_data: Record<string, unknown> | null) => ({
  cursor, entity_type: "subscribers" as const, entity_id: entityId, operation, row_data, changed_at: "2026-10-24T10:00:00Z",
});
const page = (overrides: Partial<DeltaPage> = {}): DeltaPage => ({
  status: "ok", entity_type: "subscribers", current_cursor: "3", retained_from_cursor: "0",
  snapshot_cursor: null, through_cursor: "3", next_cursor: "3", has_more: false, changes: [], ...overrides,
});

describe("offline delta sync", () => {
  it("compares bigint cursors without precision loss", () => {
    expect(compareDeltaCursors("9007199254740993", "9007199254740992")).toBe(1);
    expect(() => compareDeltaCursors("0002", "2")).toThrow(/مؤشر المزامنة/);
  });

  it("applies ordered upserts and tombstones without duplicating entity ids", () => {
    const current = [{ id: 1, name: "old" }, { id: 2, name: "keep" }];
    const result = applyDeltaChanges(current, [
      change("1", "1", "upsert", { id: 1, name: "new" }),
      change("2", "3", "upsert", { id: 3, name: "added" }),
      change("3", "2", "delete", null),
    ]);
    expect(result).toEqual([{ id: 1, name: "new" }, { id: 3, name: "added" }]);
  });

  it("rejects unordered pages and mismatched row identities", () => {
    expect(() => applyDeltaChanges([], [
      change("2", "1", "delete", null), change("1", "2", "delete", null),
    ])).toThrow(/ترتيب تغييرات/);
    expect(() => applyDeltaChanges([], [change("1", "1", "upsert", { id: 2 })])).toThrow(/لا تطابق/);
  });

  it("holds one through-cursor across pages and applies each page before moving on", async () => {
    const pull = vi.fn()
      .mockResolvedValueOnce(page({ through_cursor: "9", next_cursor: "4", has_more: true, changes: [change("4", "1", "upsert", { id: 1 })] }))
      .mockResolvedValueOnce(page({ through_cursor: "9", next_cursor: "9", has_more: false, changes: [change("9", "2", "delete", null)] }));
    const applied: string[] = [];
    const result = await pullDeltaPages({
      afterCursor: "3",
      pull,
      applyPage: async p => { applied.push(p.changes[0].cursor); },
      rebuildSnapshot: async () => { throw new Error("unexpected snapshot"); },
    });
    expect(pull.mock.calls).toEqual([
      [{ afterCursor: "3", throughCursor: null, pageSize: 200 }],
      [{ afterCursor: "4", throughCursor: "9", pageSize: 200 }],
    ]);
    expect(applied).toEqual(["4", "9"]);
    expect(result).toEqual({ cursor: "9", appliedChanges: 2, resetRequired: false });
  });

  it("rebuilds on retention gaps before continuing from the snapshot cursor", async () => {
    const pull = vi.fn()
      .mockResolvedValueOnce(page({ status: "reset_required", snapshot_cursor: "20", current_cursor: "20", changes: [] }))
      .mockResolvedValueOnce(page({ current_cursor: "22", through_cursor: "22", next_cursor: "22", changes: [change("22", "7", "upsert", { id: 7 })] }));
    const rebuilt: string[] = [];
    const result = await pullDeltaPages({
      afterCursor: null,
      pull,
      applyPage: async () => {},
      rebuildSnapshot: async cursor => { rebuilt.push(cursor); },
    });
    expect(rebuilt).toEqual(["20"]);
    expect(pull.mock.calls[1][0]).toEqual({ afterCursor: "20", throughCursor: null, pageSize: 200 });
    expect(result).toEqual({ cursor: "22", appliedChanges: 1, resetRequired: true });
  });

  it("fails closed if the server changes the page boundary", async () => {
    const pull = vi.fn()
      .mockResolvedValueOnce(page({ through_cursor: "9", next_cursor: "4", has_more: true }))
      .mockResolvedValueOnce(page({ through_cursor: "10", next_cursor: "10", has_more: false }));
    await expect(pullDeltaPages({ afterCursor: "3", pull, applyPage: async () => {}, rebuildSnapshot: async () => {} }))
      .rejects.toThrow(/تغيّر حد المزامنة/);
  });
});
