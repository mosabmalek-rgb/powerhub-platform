import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }),
}));

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: state.rpc }) }));
vi.mock("./db", () => ({ getDb: state.getDb, syncSupabaseUser: vi.fn() }));

import { appRouter } from "./routers";

describe("saveRolePolicy — Supabase runtime", () => {
  it("uses the Supabase RPC and never opens MySQL", async () => {
    state.rpc.mockResolvedValueOnce({
      data: [{ success: true, policy_id: 17, role: "manager", capability: "manageTeam", is_allowed: false }],
      error: null,
    });

    const caller = appRouter.createCaller({
      user: { id: 11, role: "admin", platformRole: "platform_admin", accountStatus: "active" } as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.admin.saveRolePolicy({ role: "manager", capability: "manageTeam", isAllowed: false }))
      .resolves.toEqual({ success: true, policyId: 17, role: "manager", capability: "manageTeam", isAllowed: false });

    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_save_role_policy", {
      p_actor_user_id: 11,
      p_role: "manager",
      p_capability: "manageTeam",
      p_is_allowed: false,
    });
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("maps Supabase authorization failures to FORBIDDEN", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "PLATFORM_ADMIN_REQUIRED" } });

    const caller = appRouter.createCaller({
      user: { id: 11, role: "admin", platformRole: "platform_admin", accountStatus: "active" } as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.admin.saveRolePolicy({ role: "manager", capability: "manageTeam", isAllowed: true }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.getDb).not.toHaveBeenCalled();
  });
});


describe("setOwnerCapabilityOverride — Supabase runtime", () => {
  const input = {
    tenantId: 44,
    userId: 22,
    capability: "viewInventory" as const,
    isAllowed: false,
  };

  it("uses the server-only Supabase RPC for an active platform admin", async () => {
    state.rpc.mockResolvedValueOnce({
      data: [{
        success: true,
        tenant_id: 44,
        user_id: 22,
        capability: "viewInventory",
        is_allowed: false,
        replayed: false,
      }],
      error: null,
    });

    const caller = appRouter.createCaller({
      user: { id: 11, role: "admin", platformRole: "platform_admin", accountStatus: "active" } as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.admin.setOwnerCapabilityOverride(input)).resolves.toEqual({
      success: true,
      targetType: "owner",
      tenantId: 44,
      userId: 22,
      capability: "viewInventory",
      isAllowed: false,
      replayed: false,
    });

    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_set_owner_capability_override", {
      p_actor_user_id: 11,
      p_tenant_id: 44,
      p_user_id: 22,
      p_capability: "viewInventory",
      p_is_allowed: false,
    });
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it.each([
    ["tenant admin without a platform role", { id: 12, role: "admin", platformRole: "tenant_manager", accountStatus: "active" }],
    ["platform support without platform-admin authority", { id: 13, role: "admin", platformRole: "platform_support", accountStatus: "active" }],
    ["inactive platform admin", { id: 14, role: "admin", platformRole: "platform_admin", accountStatus: "inactive" }],
    ["non-admin platform identity", { id: 15, role: "member", platformRole: "platform_admin", accountStatus: "active" }],
  ])("rejects %s before reaching Supabase", async (_case, user) => {
    state.rpc.mockClear();

    const caller = appRouter.createCaller({
      user: user as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.admin.setOwnerCapabilityOverride(input))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("maps a database-side platform authorization failure to FORBIDDEN", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "PLATFORM_ADMIN_REQUIRED" } });

    const caller = appRouter.createCaller({
      user: { id: 11, role: "admin", platformRole: "platform_admin", accountStatus: "active" } as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.admin.setOwnerCapabilityOverride(input))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_set_owner_capability_override", expect.any(Object));
    expect(state.getDb).not.toHaveBeenCalled();
  });
});
