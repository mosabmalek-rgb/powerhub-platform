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
    expect(resolverSource).toContain('"powerhub_site_access_snapshot"');
    expect(resolverSource).toContain("const subscription = snapshot.subscription");
    expect(resolverSource).toContain('subscription.status === "trial" || subscription.status === "active"');
    expect(resolverSource).toContain('subscription?.status === "cancelled"');
    expect(resolverSource).toContain("isTenantMembershipUnexpired(member)");
    const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261113002000_powerhub_b520_site_access_single_snapshot.sql"), "utf8");
    expect(migration).toContain("m.membership_status='active'");
    expect(migration).toContain("m.expires_at>now()");
    expect(migration).toContain("sub.ends_at DESC NULLS LAST");
  });

  it("keeps site listing and quota projections bound to unexpired memberships", () => {
    const source = readFileSync(resolve(process.cwd(), "server/powerhub-supabase.ts"), "utf8");
    expect(source).toContain("const validMemberships = (memberships ?? []).filter((member) => isTenantMembershipUnexpired(member));");
    expect(source).toContain("activeTenantIds.has(Number(profile.tenant_id))");
    expect(source).toContain(".eq(\"role\", \"technician\").eq(\"is_active\", true).eq(\"membership_status\", \"active\").or(activeTenantMembershipOrFilter())");
    expect(source).toContain(".eq(\"membership_status\", \"active\").or(activeTenantMembershipOrFilter()).neq(\"role\", \"owner\")");
  });

  it("applies membership expiry to the fallback tenant resolver", () => {
    const trpc = readFileSync(resolve(process.cwd(), "server/_core/trpc.ts"), "utf8");
    expect(trpc).toContain(".or(activeTenantMembershipOrFilter())");
    expect(trpc).toContain("isTenantMembershipUnexpired(membership)");
  });

  it("does not show expired owner or staff memberships as active in admin views", () => {
    const admin = readFileSync(resolve(process.cwd(), "server/admin-supabase.ts"), "utf8");
    const rolePolicy = readFileSync(resolve(process.cwd(), "server/admin-role-policy-router.ts"), "utf8");
    expect(admin).toContain("const membershipExpired = !isTenantMembershipUnexpired(membership);");
    expect(admin).toContain("!membershipExpired && user?.account_status === \"active\"");
    expect(rolePolicy).toContain("isTenantMembershipUnexpired(member)");
  });


  it("uses the same membership expiry boundary for mobile authentication and chat workspace selection", () => {
    const mobile = readFileSync(resolve(process.cwd(), "server/mobile-api.ts"), "utf8");
    const assistant = readFileSync(resolve(process.cwd(), "client/src/pages/AiAssistantPage.tsx"), "utf8");
    const support = readFileSync(resolve(process.cwd(), "client/src/pages/SupportChatPage.tsx"), "utf8");
    expect(mobile).toContain("isTenantMembershipUnexpired(membershipResult.data)");
    expect(mobile).toContain(".or(activeTenantMembershipOrFilter())");
    expect(assistant).toContain('.or("expires_at.is.null,expires_at.gt." + new Date().toISOString())');
    expect(support).toContain('.eq("membership_status", "active")');
    expect(support).toContain('.or("expires_at.is.null,expires_at.gt." + new Date().toISOString())');
  });

});
