import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }),
}));

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: state.rpc }) }));
vi.mock("./db", () => ({ getDb: state.getDb }));

import { inviteTenantAccess } from "./invite-tenant-access-supabase";

const baseInput = {
  actorUserId: 1,
  tenantId: 20,
  siteId: 30,
  email: " Staff@Example.Test ",
  tenantRole: "member" as const,
  siteRole: "accountant" as const,
  tokenHash: "a".repeat(64),
  expiresAt: new Date("2026-09-15T10:00:00.000Z"),
  expiresInHours: 72,
  clientOperationId: "c0e9a8e5-fbfb-4b4d-bacf-df191ac220d1",
};

describe("inviteTenantAccess Supabase adapter", () => {
  it("sends the normalized idempotency envelope through the server-only RPC", async () => {
    state.rpc.mockResolvedValue({
      data: [{ invitation_id: 41, email: "staff@example.test", expires_at: "2026-09-15T10:00:00.000Z", status: "invited", replayed: false }],
      error: null,
    });
    const result = await inviteTenantAccess(baseInput);
    const expectedFingerprint = createHash("sha256").update(JSON.stringify({
      actorUserId: 1,
      tenantId: 20,
      siteId: 30,
      email: "staff@example.test",
      tenantRole: "member",
      siteRole: "accountant",
      expiresInHours: 72,
    })).digest("hex");

    expect(result).toMatchObject({ id: 41, email: "staff@example.test", status: "invited", replayed: false });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_invite_tenant_access", expect.objectContaining({
      p_actor_user_id: 1,
      p_tenant_id: 20,
      p_site_id: 30,
      p_email: "staff@example.test",
      p_client_operation_id: baseInput.clientOperationId,
      p_request_fingerprint: expectedFingerprint,
    }));
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("reuses the same operation id and fingerprint when the caller retries", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: [{ invitation_id: 41, email: "staff@example.test", expires_at: "2026-09-15T10:00:00.000Z", status: "invited", replayed: false }], error: null })
      .mockResolvedValueOnce({ data: [{ invitation_id: 41, email: "staff@example.test", expires_at: "2026-09-15T10:00:00.000Z", status: "invited", replayed: true }], error: null });

    const first = await inviteTenantAccess(baseInput);
    const second = await inviteTenantAccess(baseInput);
    expect(first.id).toBe(second.id);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(state.rpc.mock.calls[0][1].p_client_operation_id).toBe(state.rpc.mock.calls[1][1].p_client_operation_id);
    expect(state.rpc.mock.calls[0][1].p_request_fingerprint).toBe(state.rpc.mock.calls[1][1].p_request_fingerprint);
  });

  it("maps authorization, tenant, and site scope failures", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: null, error: { message: "PLATFORM_ADMIN_REQUIRED" } })
      .mockResolvedValueOnce({ data: null, error: { message: "TENANT_NOT_FOUND" } })
      .mockResolvedValueOnce({ data: null, error: { message: "SITE_NOT_FOUND" } });

    await expect(inviteTenantAccess(baseInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(inviteTenantAccess(baseInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(inviteTenantAccess(baseInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps operation conflicts and duplicate active invitations", async () => {
    state.rpc
      .mockResolvedValueOnce({ data: null, error: { message: "OPERATION_CONFLICT" } })
      .mockResolvedValueOnce({ data: null, error: { message: "DUPLICATE_INVITATION" } });

    await expect(inviteTenantAccess(baseInput)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(inviteTenantAccess(baseInput)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
