import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const router = readFileSync(resolve(process.cwd(), "server/platform-announcements-router.ts"), "utf8");
const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261102180000_powerhub_announcement_membership_tenant_role_scope.sql"), "utf8");

describe("platform announcement tenant authorization", () => {
  it("loads expiry-aware membership identity and tenant-scoped staff roles", () => {
    expect(router).toContain('select("tenant_id,role,is_active,membership_status,expires_at")');
    expect(router).toContain(".or(activeTenantMembershipOrFilter())");
    expect(router).toContain("canUserReceiveAnnouncement(");
    expect(router).not.toContain('.overlaps("audience_roles", effectiveRoles)');
  });

  it("keeps list, single-read and bulk-read on the same authorization helper", () => {
    expect(router.match(/canUserReceiveAnnouncement\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(router).toContain('select("role,tenant_id")');
  });

  it("keeps the unread counter aligned with tenant membership expiry and tenant-local roles", () => {
    expect(migration).toContain("tm.membership_status = 'active'");
    expect(migration).toContain("(tm.expires_at is null or tm.expires_at > now())");
    expect(migration).toContain("tr.tenant_id = a.tenant_id");
    expect(migration).toContain("select a.role::text from actor a where a.role is not null");
    expect(migration).toContain("grant execute on function public.powerhub_platform_announcement_unread_count_for_user(bigint) to service_role");
    expect(migration).toContain("revoke all on function public.powerhub_platform_announcement_unread_count_for_user(bigint) from public, anon, authenticated");
  });
});
