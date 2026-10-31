import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261031210000_powerhub_platform_identity_rls_alignment.sql"),
  "utf8",
);
const serverIdentity = readFileSync(
  resolve(process.cwd(), "server/platform-admin.ts"),
  "utf8",
);

describe("Platform identity tenant-RLS contract", () => {
  it("matches the server's active platform-admin identity and role allowlist", () => {
    expect(serverIdentity).toContain('user?.role === "admin"');
    expect(serverIdentity).toContain('user.accountStatus === "active"');
    expect(serverIdentity).toContain('"platform_owner", "platform_admin", "finance_admin"');

    expect(migration).toContain("u.role = 'admin'");
    expect(migration).toContain("u.platform_role IN ('platform_owner','platform_admin','finance_admin')");
    expect(migration).toContain("u.account_status = 'active'");
  });

  it("keeps the legacy is_platform_user signature but removes platform-role-presence bypass", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION powerhub_private.is_platform_user()");
    expect(migration).toContain("SELECT powerhub_private.is_platform_admin()");
    expect(migration).not.toContain("u.platform_role IS NOT NULL");
    expect(migration).not.toContain("platform_role is not null");
  });

  it("aligns all three existing RLS helpers without broadening platform Support", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION powerhub_private.is_platform_admin()");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION private.powerhub_is_platform_admin()");
    expect(migration).toContain("Platform Support remains governed by private.powerhub_has_platform_capability");
    expect(migration).not.toContain("CREATE OR REPLACE FUNCTION private.powerhub_is_platform_management_admin");
  });

  it("preserves authenticated-only helper execution and refuses anonymous access", () => {
    expect(migration).toContain("REVOKE ALL ON FUNCTION powerhub_private.is_platform_admin() FROM PUBLIC, anon");
    expect(migration).toContain("REVOKE ALL ON FUNCTION powerhub_private.is_platform_user() FROM PUBLIC, anon");
    expect(migration).toContain("REVOKE ALL ON FUNCTION private.powerhub_is_platform_admin() FROM PUBLIC, anon");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION powerhub_private.is_platform_admin() TO authenticated");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION powerhub_private.is_platform_user() TO authenticated, service_role");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION private.powerhub_is_platform_admin() TO authenticated, service_role");
  });
});
