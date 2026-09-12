import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }),
}));

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: state.rpc }) }));
vi.mock("./db", () => ({ getDb: state.getDb, syncSupabaseUser: vi.fn() }));
vi.mock("./powerhub", () => ({
  powerhubRouter: {
    _def: {
      record: {
        mobileSync: { _def: { record: {} } },
      },
    },
  },
}));

import { appRouter } from "./routers";

describe("saveTenantBranchSettings — Supabase runtime", () => {
  beforeEach(() => {
    state.rpc.mockReset();
    state.getDb.mockClear();
  });

  it("writes through the atomic Supabase RPC and never opens MySQL", async () => {
    state.rpc.mockResolvedValueOnce({
      data: [{ tenant_id: 42, updated_at: "2026-09-12T14:00:00.000Z" }],
      error: null,
    });

    const caller = appRouter.createCaller({
      user: { id: 11, role: "admin", platformRole: "platform_admin", accountStatus: "active" } as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.admin.saveTenantBranchSettings({
      tenantId: 42,
      isEnabledOverride: true,
      maxBranchesOverride: 5,
      disabledBehavior: "read_only",
    })).resolves.toEqual({ success: true });

    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_save_tenant_branch_settings", {
      p_actor_user_id: 11,
      p_tenant_id: 42,
      p_is_enabled_override: true,
      p_max_branches_override: 5,
      p_disabled_behavior: "read_only",
    });
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("maps Supabase tenant-not-found to NOT_FOUND without falling back to MySQL", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "TENANT_NOT_FOUND" } });

    const caller = appRouter.createCaller({
      user: { id: 11, role: "admin", platformRole: "platform_admin", accountStatus: "active" } as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.admin.saveTenantBranchSettings({
      tenantId: 999,
      isEnabledOverride: null,
      maxBranchesOverride: null,
      disabledBehavior: "suspended",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(state.getDb).not.toHaveBeenCalled();
  });
});
