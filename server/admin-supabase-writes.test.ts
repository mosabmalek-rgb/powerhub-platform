import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260911200000_powerhub_admin_membership_subscription_rpcs.sql"),
  "utf8",
);

describe("Supabase atomic admin write RPCs", () => {
  it("defines the membership status migration", () => {
    expect(migration).toContain("powerhub_admin_set_tenant_membership_status");
    expect(migration).toContain("membership_status = p_status");
    expect(migration).toContain("staff_profiles");
    expect(migration).toContain("platform_admin_set_tenant_membership_status");
  });

  it("defines the owner attachment migration", () => {
    expect(migration).toContain("powerhub_admin_attach_owner_user");
    expect(migration).toContain("PLATFORM_ACCOUNT_CANNOT_BE_OWNER");
    expect(migration).toContain("tenant_owner_profiles");
    expect(migration).toContain("platform_admin_attach_owner_user");
  });

  it("defines the subscription migration", () => {
    expect(migration).toContain("powerhub_admin_update_subscription");
    expect(migration).toContain("tenant_subscriptions");
    expect(migration).toContain("platform_sms_plans");
    expect(migration).toContain("platform_admin_update_subscription");
  });

  it("restricts all three RPCs to service_role", () => {
    expect(migration).toContain("revoke all on function public.powerhub_admin_set_tenant_membership_status");
    expect(migration).toContain("revoke all on function public.powerhub_admin_attach_owner_user");
    expect(migration).toContain("revoke all on function public.powerhub_admin_update_subscription");
    expect(migration).toContain("grant execute on function public.powerhub_admin_set_tenant_membership_status");
    expect(migration).toContain("grant execute on function public.powerhub_admin_attach_owner_user");
    expect(migration).toContain("grant execute on function public.powerhub_admin_update_subscription");
    expect(migration.match(/to service_role;/g)?.length).toBe(3);
  });

  it("uses security definer with a fixed search path", () => {
    expect((migration.match(/security definer/g) ?? []).length).toBe(3);
    expect((migration.match(/set search_path = public, pg_temp/g) ?? []).length).toBe(3);
  });

  it("uses the Supabase staff profile uniqueness key for owner attachment", () => {
    expect(migration).toContain("on conflict (user_id, site_id, role)");
  });
});
