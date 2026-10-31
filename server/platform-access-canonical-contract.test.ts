import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const serverRoot = join(process.cwd(), "server");

describe("platform access Supabase canonical contract", () => {
  it("retires obsolete adapter files from the runtime tree", () => {
    expect(existsSync(join(serverRoot, "platform-access-supabase.ts"))).toBe(false);
    expect(existsSync(join(serverRoot, "platform-invitation-supabase.ts"))).toBe(false);
  });

  it("keeps the canonical platform invitation RPC on the 7-argument idempotent contract", () => {
    const source = readFileSync(join(serverRoot, "admin-platform-access-supabase.ts"), "utf8");
    expect(source).toContain('rpc("powerhub_admin_invite_platform_access"');
    expect(source).toContain("p_token_hash: tokenHash");
    expect(source).toContain("p_expires_at: expiresAt");
    expect(source).toContain("p_client_operation_id: input.clientOperationId");
    expect(source).toContain("p_request_fingerprint: requestFingerprint");
    expect(source).toContain("replayed: row.replayed === true");
    expect(source).not.toContain("p_expires_in_hours");
  });

  it("uses the idempotent tenant invitation adapter and router contract", () => {
    const adapter = readFileSync(join(serverRoot, "invite-tenant-access-supabase.ts"), "utf8");
    const router = readFileSync(join(serverRoot, "admin-tenant-access-router.ts"), "utf8");
    expect(adapter).toContain('rpc("powerhub_admin_invite_tenant_access"');
    expect(adapter).toContain("p_client_operation_id: input.clientOperationId");
    expect(adapter).toContain("p_request_fingerprint: requestFingerprint");
    expect(adapter).toContain("replayed: row.replayed === true");
    expect(router).toContain("clientOperationId: z.string().uuid()");
    expect(router).toContain("expiresInHours: input.expiresInHours");
  });

  it("keeps tenant invitation permission and runtime typing explicit", () => {
    const router = readFileSync(join(serverRoot, "admin-tenant-access-router.ts"), "utf8");
    const composition = readFileSync(join(serverRoot, "admin-platform-setting-router.ts"), "utf8");
    const adapter = readFileSync(join(serverRoot, "invite-tenant-access-supabase.ts"), "utf8");
    expect(router).toContain('["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "")');
    expect(router).toContain('ctx.user.accountStatus !== "active"');
    expect(router).toContain("clientOperationId: z.string().uuid()");
    expect(router).toContain("expiresInHours: z.number().int().min(1).max(168).default(72)");
    expect(adapter).toContain("expiresInHours: input.expiresInHours");
    expect(adapter).toContain("p_request_fingerprint: requestFingerprint");
    expect(composition).toContain('Omit<typeof adminRouter, "inviteTenantAccess">');
    expect(composition).toContain("inviteTenantAccess: typeof adminTenantAccessRouter.inviteTenantAccess");
  });

  it("connects tenant invitation UI with stable retry identifiers and directory invalidation", () => {
    const source = readFileSync(join(process.cwd(), "client/src/pages/TenantAccessInvitationPanel.tsx"), "utf8");
    const page = readFileSync(join(process.cwd(), "client/src/pages/AdminConsolePage.tsx"), "utf8");
    expect(source).toContain("globalThis.crypto.randomUUID()");
    expect(source).toContain("pendingOperation.current.clientOperationId");
    expect(source).toContain("utils.admin.platformSnapshot.invalidate()");
    expect(source).toContain("لا يرسل هذا الإجراء رسالة بريد إلكتروني تلقائيًا");
    expect(page).toContain("<TenantAccessInvitationPanel");
    expect(page).toContain('row.kind === "tenant" && row.invitationStatus === "invited"');
  });

  it("routes platform access mutations through the canonical Supabase adapter", () => {
    const source = readFileSync(join(serverRoot, "admin-platform-access-router.ts"), "utf8");
    expect(source).toContain('from "./admin-platform-access-supabase"');
    expect(source).toContain("invitePlatformAccessSupabase");
    expect(source).toContain("setPlatformAccountStatusSupabase");
    expect(source).toContain("setPlatformAccessRoleSupabase");
  });
});
