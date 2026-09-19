import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }),
}));

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ rpc: state.rpc }) }));
vi.mock("./db", () => ({ getDb: state.getDb }));

import { inviteTenantAccess } from "./invite-tenant-access-supabase";

describe("inviteTenantAccess Supabase adapter", () => {
  it("creates the invitation through the Supabase RPC only", async () => {
    state.rpc.mockResolvedValue({ data: [{ invitation_id: 41, email: "staff@example.test", expires_at: "2026-09-15T10:00:00.000Z", status: "invited", replayed: false }], error: null });
    const result = await inviteTenantAccess({
      actorUserId: 1,
      tenantId: 20,
      siteId: 30,
      email: "staff@example.test",
      tenantRole: "member",
      siteRole: "accountant",
      tokenHash: "a".repeat(64),
      expiresAt: new Date("2026-09-15T10:00:00.000Z"), clientOperationId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result).toMatchObject({ id: 41, email: "staff@example.test", status: "invited" });
    expect(state.rpc).toHaveBeenCalledWith("powerhub_admin_invite_tenant_access", expect.objectContaining({ p_actor_user_id: 1, p_tenant_id: 20, p_site_id: 30 }));
    expect(state.getDb).not.toHaveBeenCalled();
  });

  it("maps authorization failure to FORBIDDEN", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "PLATFORM_ADMIN_REQUIRED" } });
    await expect(inviteTenantAccess({ actorUserId: 2, tenantId: 20, email: "staff@example.test", tenantRole: "member", tokenHash: "a".repeat(64), expiresAt: new Date("2026-09-15T10:00:00.000Z") })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("maps tenant and site scope failures", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "TENANT_NOT_FOUND" } });
    await expect(inviteTenantAccess({ actorUserId: 1, tenantId: 999, email: "staff@example.test", tenantRole: "member", tokenHash: "a".repeat(64), expiresAt: new Date("2026-09-15T10:00:00.000Z") })).rejects.toMatchObject({ code: "NOT_FOUND" });
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "SITE_NOT_FOUND" } });
    await expect(inviteTenantAccess({ actorUserId: 1, tenantId: 20, siteId: 999, email: "staff@example.test", tenantRole: "member", tokenHash: "a".repeat(64), expiresAt: new Date("2026-09-15T10:00:00.000Z") })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
