import { describe, expect, it, vi } from "vitest";

const state = {
  rpc: vi.fn(),
};

vi.mock("./supabase-admin", () => ({
  supabaseAdmin: () => ({ rpc: state.rpc }),
}));

vi.mock("./db", () => ({
  getDb: vi.fn(async () => {
    throw new Error("MySQL must not be called by the Supabase owner access recovery path");
  }),
}));

import { requestOwnerAccessRecovery } from "./request-owner-access-recovery-supabase";

describe("requestOwnerAccessRecovery Supabase adapter", () => {
  it("calls the atomic RPC with server-derived actor context", async () => {
    state.rpc.mockResolvedValueOnce({
      data: [{ success: true, recovery_request_id: 901 }],
      error: null,
    });

    await expect(requestOwnerAccessRecovery({
      actorUserId: 12,
      tenantId: 44,
      note: "طلب اختبار",
      clientOperationId: "11111111-1111-4111-8111-111111111111",
    })).resolves.toEqual({
      success: true,
      delivery: "deferred",
      recoveryRequestId: 901,
    });

    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_request_owner_access_recovery", {
      p_actor_user_id: 12,
      p_tenant_id: 44,
      p_note: "طلب اختبار",
      p_client_operation_id: "11111111-1111-4111-8111-111111111111",
      p_request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("maps authorization failures to FORBIDDEN", async () => {
    state.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "FORBIDDEN: منصة PowerHub لا تملك صلاحية طلب استرداد الوصول." },
    });

    await expect(requestOwnerAccessRecovery({ actorUserId: 12, tenantId: 44, clientOperationId: "22222222-2222-4222-8222-222222222222" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("maps a missing owner profile to NOT_FOUND", async () => {
    state.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "OWNER_PROFILE_NOT_FOUND" },
    });

    await expect(requestOwnerAccessRecovery({ actorUserId: 12, tenantId: 44, clientOperationId: "33333333-3333-4333-8333-333333333333" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
