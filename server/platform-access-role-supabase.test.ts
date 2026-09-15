import { describe, expect, it } from "vitest";

const migration = "supabase/migrations/20260912134000_powerhub_admin_set_platform_access_role_rpc.sql";

describe("platform access role Supabase migration contract", () => {
  it("keeps the migration security and authorization contract explicit", async () => {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(migration, "utf8");

    expect(sql).toContain("powerhub_admin_set_platform_access_role");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public, pg_temp");
    expect(sql).toContain("platform_owner");
    expect(sql).toContain("platform_admin");
    expect(sql).toContain("finance_admin");
    expect(sql).toContain("SELF_ROLE_CHANGE");
    expect(sql).toContain("ACCOUNT_NOT_FOUND");
    expect(sql).toContain("PLATFORM_OWNER_PROTECTED");
    expect(sql).toContain("INVALID_PLATFORM_ROLE");
    expect(sql).toContain("platform_security_events");
    expect(sql).toContain("revoke all on function public.powerhub_admin_set_platform_access_role");
    expect(sql).toContain("grant execute on function public.powerhub_admin_set_platform_access_role(bigint, bigint, text) to service_role");
  });

  it("keeps the adapter on Supabase RPC instead of Drizzle/MySQL", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("server/platform-access-role-supabase.ts", "utf8");

    expect(source).toContain('from "./supabase-admin"');
    expect(source).toContain('rpc("powerhub_admin_set_platform_access_role"');
    expect(source).not.toContain("getDb");
    expect(source).not.toContain("drizzle-orm");
    expect(source).not.toContain("../drizzle/schema");
  });

  it("keeps the public tRPC procedure wired through the current Supabase override composition", async () => {
    const { readFile } = await import("node:fs/promises");
    const router = await readFile("server/admin-platform-access-role-router.ts", "utf8");
    const tariffRouter = await readFile("server/admin-tariff-policy-router.ts", "utf8");
    const platformRouter = await readFile("server/admin-platform-setting-router.ts", "utf8");
    const appRouter = await readFile("server/routers.ts", "utf8");

    expect(router).toContain("setPlatformAccessRole");
    expect(router).toContain("setPlatformAccessRole({");
    expect(router).toContain("platform_owner");
    expect(router).toContain("accountStatus !== \"active\"");
    expect(router).toContain("as typeof adminRouter");
    expect(tariffRouter).toContain("adminRouterWithSupabasePlatformAccessRole");
    expect(platformRouter).toContain("adminRouterWithSupabaseTariffPolicy");
    expect(platformRouter).toContain("_def.record");
    expect(appRouter).toContain("adminRouterWithSupabasePlatformSetting");
    expect(appRouter).toContain("const adminRuntimeRouter = (router(adminRuntimeRecord");
    expect(appRouter).toContain("admin: adminRuntimeRouter");
  });
});
