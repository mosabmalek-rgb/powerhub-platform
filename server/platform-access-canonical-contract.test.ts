import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const serverRoot = join(process.cwd(), "server");

describe("platform access Supabase canonical contract", () => {
  it("retires obsolete adapter files from the runtime tree", () => {
    expect(existsSync(join(serverRoot, "platform-access-supabase.ts"))).toBe(false);
    expect(existsSync(join(serverRoot, "platform-invitation-supabase.ts"))).toBe(false);
  });

  it("keeps the canonical invitation RPC on the 5-argument contract", () => {
    const source = readFileSync(join(serverRoot, "admin-platform-access-supabase.ts"), "utf8");
    expect(source).toContain('rpc("powerhub_admin_invite_platform_access"');
    expect(source).toContain("p_token_hash: tokenHash");
    expect(source).toContain("p_expires_at: expiresAt");
    expect(source).not.toContain("p_expires_in_hours");
  });

  it("routes platform access mutations through the canonical Supabase adapter", () => {
    const source = readFileSync(join(serverRoot, "admin-platform-access-router.ts"), "utf8");
    expect(source).toContain('from "./admin-platform-access-supabase"');
    expect(source).toContain("invitePlatformAccess as invitePlatformAccessSupabase");
    expect(source).toContain("setPlatformAccountStatus as setPlatformAccountStatusSupabase");
    expect(source).toContain("setPlatformAccessRole as setPlatformAccessRoleSupabase");
  });
});
