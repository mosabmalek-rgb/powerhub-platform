import { describe, expect, it } from "vitest";

describe("tariff policy Supabase migration contract", () => {
  it("keeps tariff creation atomic, authorized, and service-role only", async () => {
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile("supabase/migrations/20260912141000_powerhub_admin_create_tariff_policy_rpc.sql", "utf8");

    expect(sql).toContain("powerhub_admin_create_tariff_policy");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public, pg_temp");
    expect(sql).toContain("platform_owner");
    expect(sql).toContain("platform_admin");
    expect(sql).toContain("INVALID_TARIFF_RANGE");
    expect(sql).toContain("INVALID_EFFECTIVE_FROM");
    expect(sql).toContain("platform_tariff_policies");
    expect(sql).toContain("notification_messages");
    expect(sql).toContain("platform_security_events");
    expect(sql).toContain("revoke all on function public.powerhub_admin_create_tariff_policy");
    expect(sql).toContain("grant execute on function public.powerhub_admin_create_tariff_policy(bigint, numeric, numeric, timestamptz, boolean, text) to service_role");
  });

  it("keeps the adapter on Supabase RPC instead of Drizzle/MySQL", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("server/tariff-policy-supabase.ts", "utf8");

    expect(source).toContain('from "./supabase-admin"');
    expect(source).toContain('rpc("powerhub_admin_create_tariff_policy"');
    expect(source).not.toContain("getDb");
    expect(source).not.toContain("drizzle-orm");
    expect(source).not.toContain("../drizzle/schema");
  });

  it("keeps the public tRPC procedure wired through the Supabase override", async () => {
    const { readFile } = await import("node:fs/promises");
    const router = await readFile("server/admin-tariff-policy-router.ts", "utf8");
    const appRouter = await readFile("server/routers.ts", "utf8");

    expect(router).toContain("createTariffPolicy");
    expect(router).toContain("platform_owner");
    expect(router).toContain("platform_admin");
    expect(router).toContain("accountStatus !== \"active\"");
    expect(router).toContain("as typeof adminRouter");
    expect(appRouter).toContain("adminRouterWithSupabaseTariffPolicy");
    expect(appRouter).toContain("admin: adminRouterWithSupabaseTariffPolicy");
  });
});
