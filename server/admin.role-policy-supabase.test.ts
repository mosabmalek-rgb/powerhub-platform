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
