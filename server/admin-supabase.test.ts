import { describe, expect, it, vi } from "vitest";

const rowsByTable: Record<string, unknown[]> = {};

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const result = () => Promise.resolve({ data: rowsByTable[table] ?? [], error: null });
      const query = { order: () => query, limit: result, in: result, not: () => query, eq: () => query };
      return { select: () => query };
    },
  }),
}));

import { platformSnapshotFromSupabase } from "./admin-supabase";

describe("ملخص إدارة Supabase", () => {
  it("يعيد لقطة نظيفة للوحة المالك من Supabase دون بيانات اختبار", async () => {
    const snapshot = await platformSnapshotFromSupabase();
    expect(snapshot.generators.total).toBe(0);
    expect(snapshot.users.total).toBe(0);
    expect(snapshot.reports).toMatchObject({ tenants: 0, subscribers: 0, approvedReadings: 0 });
    expect(snapshot.finance).toMatchObject({ overdueAmount: 0, completedAmount: 0 });
  });
});
