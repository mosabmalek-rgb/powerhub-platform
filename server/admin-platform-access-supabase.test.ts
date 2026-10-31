import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: state.rpc }) }));

import { invitePlatformAccessSupabase } from "./admin-platform-access-supabase";

const input = {
  actorUserId: 7,
  email: "  STAFF@Example.Test ",
  platformRole: "platform_support" as const,
  expiresInHours: 48,
  clientOperationId: "c0e9a8e5-fbfb-4b4d-bacf-df191ac220d1",
};

afterEach(() => vi.clearAllMocks());

describe("platform invitation idempotency adapter", () => {
  it("sends a server-computed normalized request fingerprint and returns replay state", async () => {
    state.rpc.mockResolvedValue({
      data: [{ id: 81, email: "staff@example.test", platform_role: "platform_support", status: "invited", expires_at: "2026-10-31T12:00:00.000Z", replayed: false }],
      error: null,
    });

    const result = await invitePlatformAccessSupabase(input);
    const expectedFingerprint = createHash("sha256").update(JSON.stringify({
      actorUserId: 7,
      email: "staff@example.test",
      platformRole: "platform_support",
      expiresInHours: 48,
    })).digest("hex");

    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_invite_platform_access", expect.objectContaining({
      p_actor_user_id: 7,
      p_email: "staff@example.test",
      p_platform_role: "platform_support",
      p_client_operation_id: input.clientOperationId,
      p_request_fingerprint: expectedFingerprint,
    }));
    expect(result).toMatchObject({ id: 81, email: "staff@example.test", replayed: false });
    expect(state.rpc.mock.calls[0][1].p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.rpc.mock.calls[0][1].p_expires_at).toBeTruthy();
  });

  it("keeps the fingerprint stable across a retry and exposes replayed=true", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: [{ id: 82, email: "staff@example.test", platform_role: "platform_support", status: "invited", expires_at: "2026-10-31T12:00:00.000Z", replayed: false }], error: null })
      .mockResolvedValueOnce({ data: [{ id: 82, email: "staff@example.test", platform_role: "platform_support", status: "invited", expires_at: "2026-10-31T12:00:00.000Z", replayed: true }], error: null });

    const first = await invitePlatformAccessSupabase(input);
    const second = await invitePlatformAccessSupabase(input);
    expect(first.id).toBe(second.id);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(state.rpc.mock.calls[0][1].p_client_operation_id).toBe(state.rpc.mock.calls[1][1].p_client_operation_id);
    expect(state.rpc.mock.calls[0][1].p_request_fingerprint).toBe(state.rpc.mock.calls[1][1].p_request_fingerprint);
  });

  it("maps operation conflicts and duplicate invitations to CONFLICT", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: null, error: { message: "OPERATION_CONFLICT" } })
      .mockResolvedValueOnce({ data: null, error: { message: "DUPLICATE_INVITATION" } });

    await expect(invitePlatformAccessSupabase(input)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(invitePlatformAccessSupabase(input)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("maps existing platform accounts to CONFLICT", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "ACCOUNT_ALREADY_EXISTS" } });
    await expect(invitePlatformAccessSupabase(input)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
