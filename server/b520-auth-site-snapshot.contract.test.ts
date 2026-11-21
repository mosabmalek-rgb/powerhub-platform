import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const profile = read("server/supabase-profile.ts");
const auth = read("server/_core/supabase-auth.ts");
const context = read("server/_core/context.ts");
const site = read("server/powerhub-supabase.ts");
const sql = read("supabase/migrations/20261113002000_powerhub_b520_site_access_single_snapshot.sql");

describe("B5.20 profile and immediate authorization read contracts", () => {
  it("keeps normal request profiles read-only and bootstraps only explicit authentication", () => {
    expect(profile).toContain("if (!options.bootstrap)");
    expect(profile).toContain("return mapSupabaseProfile(existing as UserRow)");
    expect(profile).toContain('throw new Error("تعذر تحميل ملف المستخدم؛ يجب إكمال تهيئة تسجيل الدخول.")');
    expect(auth).toContain("syncSupabaseProfile({");
    expect(auth).toContain("}, options)");
    expect(context).toContain("isExplicitAuthBootstrap(opts.req)");
    expect(context).toContain("auth\\.me|auth\\.claimDevice");
  });

  it("reduces site authorization and policy checks to one service-only fresh snapshot", () => {
    expect(site).toContain('.rpc("powerhub_site_access_snapshot"');
    expect(site).toContain('account_status !== "active"');
    expect(site).toContain("!isTenantMembershipUnexpired(member)");
    expect(site).toContain("deniedCapabilities: policyDeny(role)");
    expect(site).toContain("access.deniedCapabilities.includes(capability)");
    expect(site).not.toContain('supabaseAdmin().from("platform_role_policies")');
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.powerhub_site_access_snapshot(bigint,bigint) FROM PUBLIC,anon,authenticated");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.powerhub_site_access_snapshot(bigint,bigint) TO service_role");
    expect(sql).toContain("m.expires_at>now()");
  });

  it("does not broaden role grants or bypass tenant/source checks", () => {
    expect(site).toContain("const platformAdmin = isActivePlatformAdmin");
    expect(site).toContain('snapshot.membership');
    expect(site).toContain("tenantId = Number(site.tenant_id)");
    expect(site).toContain("applyStaffCapabilityOverrides(permissions, overrides)");
    expect(site).toContain("profile.suspension_started_at");
  });
});
