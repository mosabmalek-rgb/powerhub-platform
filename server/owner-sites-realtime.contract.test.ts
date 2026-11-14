import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const siteModule = readFileSync("server/powerhub-supabase.ts", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

describe("owner branch bootstrap / Realtime origin contracts", () => {
  it("disambiguates the sites-to-tenants foreign key in every PostgREST embed", () => {
    // Supabase PostgREST returns HTTP 300 / PGRST201 for ambiguous embeddings.
    expect(siteModule).not.toContain("tenants!inner(name)");
    expect((siteModule.match(/tenants!sites_tenant_id_fkey\(name\)/g) ?? []).length).toBe(4);
    expect(siteModule).toContain('.in("tenant_id", ownerTenantIds)');
    expect(siteModule).toContain('.in("id", requestedIds)');
    expect(siteModule).toContain("isTenantMembershipUnexpired(member)");
    expect(siteModule).toContain("activeTenantIds.has(Number(profile.tenant_id))");
    expect(siteModule).toContain("ownedCode: ownedResult.error?.code");
    expect(siteModule).toContain("assignedCode: assignedResult.error?.code");
  });

  it("allows HTTPS Supabase requests and WSS Realtime only to Supabase subdomains", () => {
    const policies = vercel.headers
      .map(({ headers }) => headers.find(({ key }) => key === "Content-Security-Policy")?.value)
      .filter((value): value is string => Boolean(value));
    expect(policies).toHaveLength(3);
    for (const policy of policies) {
      expect(policy).toContain("connect-src 'self' https://*.supabase.co wss://*.supabase.co");
      expect(policy).not.toContain("connect-src *");
      expect(policy).toContain("object-src 'none'");
    }
  });
});
