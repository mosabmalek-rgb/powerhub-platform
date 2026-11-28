import { describe, expect, it } from "vitest";
import { compareChatMessageOrder } from "./chat-message-order";

describe("chat message order", () => {
  it("uses message ID to break equal PostgreSQL timestamp ties", () => {
    const rows = [{ id: 103, created_at: "2026-01-01T00:01:00Z" }, { id: 101, created_at: "2026-01-01T00:01:00+00:00" }];
    expect(rows.sort(compareChatMessageOrder).map(row => row.id)).toEqual([101, 103]);
  });
  it("preserves microsecond chronology before comparing IDs", () => {
    const rows = [{ id: 1, created_at: "2026-01-01T00:00:00.001002Z" }, { id: 9, created_at: "2026-01-01T00:00:00.001001+00:00" }];
    expect(rows.sort(compareChatMessageOrder).map(row => row.id)).toEqual([9, 1]);
  });
  it("compares offset timestamps by instant and treats trailing fractional zeroes as equal", () => {
    const rows = [{ id: 3, created_at: "2026-01-01T02:00:00.1+02:00" }, { id: 2, created_at: "2026-01-01T00:00:00.100000Z" }, { id: 4, created_at: "2026-01-01T00:00:00.099999Z" }];
    expect(rows.sort(compareChatMessageOrder).map(row => row.id)).toEqual([4, 2, 3]);
  });
});
