import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const updates: Array<{ table: string; values: unknown }> = [];
  const inserts: Array<{ table: string; values: unknown }> = [];
  const resolved = (data: unknown = null) => Promise.resolve({ data, error: null });

  const query = (table: string) => {
    const selected = table === "tenants" ? { id: 10, status: "active" }
      : table === "sites" ? { id: 20 }
        : table === "generators" ? { id: 30, tenant_id: 10, site_id: 20, status: "pending" }
          : null;
    const selectQuery = {
      eq: () => selectQuery,
      order: () => selectQuery,
      limit: () => selectQuery,
      maybeSingle: () => resolved(selected),
    };
    const updateQuery = {
      eq: () => updateQuery,
      select: () => ({ maybeSingle: () => resolved({ id: 30 }) }),
      then: <TResult1 = { data: null; error: null }, TResult2 = never>(
        onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => resolved().then(onfulfilled, onrejected),
    };
    const insertQuery = {
      then: <TResult1 = { data: null; error: null }, TResult2 = never>(
        onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => resolved().then(onfulfilled, onrejected),
    };
    return {
      select: () => selectQuery,
      update(values: unknown) { updates.push({ table, values }); return updateQuery; },
      insert(values: unknown) { inserts.push({ table, values }); return insertQuery; },
    };
  };
  return { updates, inserts, client: { from: query } };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));

import { adminRouter } from "./admin";

const adminContext = { user: { id: 1, role: "admin", platformRole: "platform_owner", accountStatus: "active" } as never, req: {} as never, res: {} as never };

describe("إجراءات حالة الإدارة عبر Supabase", () => {
  beforeEach(() => {
    state.updates.splice(0);
    state.inserts.splice(0);
  });

  it("يوقف المستأجر والاشتراك ويرصد سجل التدقيق عبر Supabase", async () => {
    const caller = adminRouter.createCaller(adminContext);
    await expect(caller.setTenantStatus({ tenantId: 10, status: "suspended" })).resolves.toEqual({ success: true });
    expect(state.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "tenants", values: { status: "suspended" } }),
      expect.objectContaining({ table: "tenant_subscriptions", values: { status: "suspended" } }),
    ]));
    expect(state.inserts).toEqual(expect.arrayContaining([expect.objectContaining({ table: "audit_logs" })]));
  });

  it("يحدّث حالة المولد ويسجلها عبر Supabase", async () => {
    const caller = adminRouter.createCaller(adminContext);
    await expect(caller.setGeneratorStatus({ id: 30, status: "maintenance" })).resolves.toEqual({ success: true });
    expect(state.updates).toEqual(expect.arrayContaining([expect.objectContaining({ table: "generators", values: { status: "maintenance" } })]));
    expect(state.inserts).toEqual(expect.arrayContaining([expect.objectContaining({ table: "audit_logs" })]));
  });

  it("يعتمد المولد المعلق بتحديث مشروط يمنع سباق الحالة", async () => {
    const caller = adminRouter.createCaller(adminContext);
    await expect(caller.approvePendingGenerator({ generatorId: 30 })).resolves.toEqual({ success: true, generatorId: 30, status: "active" });
    expect(state.updates).toEqual(expect.arrayContaining([expect.objectContaining({ table: "generators", values: { status: "active" } })]));
    expect(state.inserts).toEqual(expect.arrayContaining([expect.objectContaining({ table: "audit_logs" })]));
  });
});
