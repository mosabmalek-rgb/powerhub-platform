import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260911200000_powerhub_admin_membership_subscription_rpcs.sql"), "utf8");

describe("Admin Supabase migration stage", () => {
  it("contains the three guarded-write RPC contracts", () => {
    expect(migration).toContain("powerhub_admin_set_tenant_membership_status");
    expect(migration).toContain("powerhub_admin_attach_owner_user");
    expect(migration).toContain("powerhub_admin_update_subscription");
  });
  it("keeps the RPCs service-role only", () => {
    expect(migration.match(/revoke all on function public\.powerhub_admin_/g)?.length).toBe(3);
    expect(migration.match(/grant execute on function public\.powerhub_admin_/g)?.length).toBe(3);
    expect(migration.match(/to service_role;/g)?.length).toBe(3);
  });
});
