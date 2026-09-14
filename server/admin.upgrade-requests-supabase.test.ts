import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const calls: Array<{ table: string }> = [];
  const rows: Record<string, unknown[]> = {
    subscription_upgrade_requests: [{ id: 90, tenant_id: 20, current_plan: "starter", requested_plan: "professional", status: "pending", note: "زيادة المشتركين", created_at: "2026-08-27T00:00:00.000Z", reviewed_at: null }],
    tenants: [{ id: 20, name: "مولدات الاختبار" }],
    tenant_owner_profiles: [{ tenant_id: 20, full_name: "مالك الاختبار", email: "owner@example.com" }],
  };
  const client = {
    from(table: string) {
      calls.push({ table });
      const result = () => Promise.resolve({ data: rows[table] ?? [], error: null });
      const query = { order: () => query, limit: result, in: result };
      return { select: () => query };
    },
  };
  return { calls, client };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));

import { adminRouter } from "./admin";

describe("طلبات ترقية الباقات الإدارية عبر Supabase", () => {
  it("يعرض الطلبات ومالك كل مساحة من Supabase دون MySQL", async () => {
    state.calls.splice(0);
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin", accountStatus: "active" } as never, req: {} as never, res: {} as never });
    await expect(caller.listSubscriptionUpgradeRequests()).resolves.toMatchObject([{
      id: 90, tenantId: 20, tenantName: "مولدات الاختبار", ownerName: "مالك الاختبار", ownerEmail: "owner@example.com", requestedPlan: "professional",
    }]);
    expect(state.calls.map((call) => call.table)).toEqual(["subscription_upgrade_requests", "tenants", "tenant_owner_profiles"]);
  });
});
