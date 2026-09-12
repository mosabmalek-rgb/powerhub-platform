import { describe, expect, it, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ rpc: state.rpc }),
}));

describe("admin SMS plan Supabase adapter", () => {
  beforeEach(() => state.rpc.mockReset());

  it("creates a plan through the atomic Supabase RPC", async () => {
    state.rpc.mockResolvedValue({
      data: [{ id: 7, code: "starter_sms", name: "البداية", description: null, included_messages: 100, is_active: true, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" }],
      error: null,
    });
    const { createSmsPlanSupabase } = await import("./admin-sms-plan-supabase");
    await expect(createSmsPlanSupabase({ actorUserId: 1, code: "starter_sms", name: "البداية", includedMessages: 100, isActive: true })).resolves.toMatchObject({ id: 7, code: "starter_sms", includedMessages: 100 });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_create_sms_plan", expect.objectContaining({ p_actor_user_id: 1, p_code: "starter_sms", p_included_messages: 100 }));
  });

  it("maps duplicate codes to conflict", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "DUPLICATE_CODE" } });
    const { createSmsPlanSupabase } = await import("./admin-sms-plan-supabase");
    await expect(createSmsPlanSupabase({ actorUserId: 1, code: "starter_sms", name: "البداية", includedMessages: 100 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("updates a plan through the atomic Supabase RPC", async () => {
    state.rpc.mockResolvedValue({
      data: [{ id: 7, code: "starter_sms", name: "البداية+", description: "محدثة", included_messages: 200, is_active: false, created_at: "2026-09-12T00:00:00Z", updated_at: "2026-09-12T01:00:00Z" }],
      error: null,
    });
    const { updateSmsPlanSupabase } = await import("./admin-sms-plan-supabase");
    await expect(updateSmsPlanSupabase({ actorUserId: 1, id: 7, name: "البداية+", description: "محدثة", includedMessages: 200, isActive: false })).resolves.toMatchObject({ id: 7, includedMessages: 200, isActive: false });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_update_sms_plan", expect.objectContaining({ p_actor_user_id: 1, p_id: 7, p_included_messages: 200, p_is_active: false }));
  });

  it("maps missing plans to not found", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "PLAN_NOT_FOUND" } });
    const { updateSmsPlanSupabase } = await import("./admin-sms-plan-supabase");
    await expect(updateSmsPlanSupabase({ actorUserId: 1, id: 404, isActive: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
