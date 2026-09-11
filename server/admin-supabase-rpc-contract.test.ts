import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260911200000_powerhub_admin_membership_subscription_rpcs.sql"), "utf8");
const grants = readFileSync(resolve(process.cwd(), "supabase/migrations/20260911201000_powerhub_admin_rpc_grants.sql"), "utf8");

const rpcNames = [
  "powerhub_admin_set_tenant_membership_status",
  "powerhub_admin_attach_owner_user",
  "powerhub_admin_update_subscription",
];

describe("admin Supabase RPC contracts", () => {
  it("keeps the three migration RPCs SECURITY DEFINER and locked to service_role", () => {
    for (const name of rpcNames) {
      expect(migration).toContain(`create or replace function public.${name}`);
      expect(migration).toContain("security definer");
      expect(grants).toContain(`revoke all on function public.${name}`);
      expect(grants).toContain(`grant execute on function public.${name}`);
      expect(grants).toContain("to service_role");
    }
  });

  it("keeps the legacy admin write guard intact while runtime wiring is staged", () => {
    const admin = readFileSync(resolve(process.cwd(), "server/admin.ts"), "utf8");
    expect(admin).toContain("function assertLegacyAdminWriteMigrationGuard");
    expect(admin).toContain("powerhub_admin_set_tenant_membership_status");
    expect(admin).toContain("powerhub_admin_attach_owner_user");
    expect(admin).toContain("powerhub_admin_update_subscription");
  });
});
