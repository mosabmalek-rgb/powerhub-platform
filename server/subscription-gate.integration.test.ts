import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("tenant subscription gate integration contract", () => {
  it("enforces subscription state at the central site-access resolver", () => {
    const source = readFileSync(resolve(process.cwd(), "server/powerhub-supabase.ts"), "utf8");

    expect(source).toContain('import { requireTenantSubscription } from "./subscription-access";');
    const resolverStart = source.indexOf("async function resolveSupabaseSiteAccessDetails");
    expect(resolverStart).toBeGreaterThanOrEqual(0);
    const resolverSource = source.slice(resolverStart);
    expect(resolverSource).toContain("requireTenantSubscription(site.tenantId, new Date(), { allowReadOnlyRetention: true })");
    expect(resolverSource).toContain("Promise.all");
    expect(resolverSource).toContain("tenant_members");
    expect(resolverSource).toContain(".or(activeTenantMembershipOrFilter())");
    expect(resolverSource).toContain("if (!isTenantMembershipUnexpired(membership))");
  });

  it("keeps site listing and quota projections bound to unexpired memberships", () => {
    const source = readFileSync(resolve(process.cwd(), "server/powerhub-supabase.ts"), "utf8");
    expect(source).toContain("const validMemberships = (memberships ?? []).filter((member) => isTenantMembershipUnexpired(member));");
    expect(source).toContain("activeTenantIds.has(Number(profile.tenant_id))");
    expect(source).toContain(".eq(\"role\", \"technician\").eq(\"is_active\", true).eq(\"membership_status\", \"active\").or(activeTenantMembershipOrFilter())");
    expect(source).toContain(".eq(\"membership_status\", \"active\").or(activeTenantMembershipOrFilter()).neq(\"role\", \"owner\")");
  });
});
