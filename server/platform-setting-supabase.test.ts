import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migrationPath = join(root, "supabase/migrations/20260912143000_powerhub_admin_save_platform_setting_rpc.sql");
const adapterPath = join(root, "server/platform-setting-supabase.ts");
const routerPath = join(root, "server/admin-platform-setting-router.ts");
const appRouterPath = join(root, "server/routers.ts");

function read(path: string) {
  return readFileSync(path, "utf8");
}

describe("platform settings Supabase migration", () => {
  it("defines an atomic service-role-only SECURITY DEFINER RPC", () => {
    const sql = read(migrationPath);
    expect(sql).toContain("create or replace function public.powerhub_admin_save_platform_setting");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = public, pg_temp");
    expect(sql).toContain("on conflict (setting_key) do update");
    expect(sql).toContain("insert into public.platform_security_events");
    expect(sql).toContain("INVALID_SETTING_KEY");
    expect(sql).toContain("INVALID_SETTING_MESSAGE");
    expect(sql).toContain("revoke all on function public.powerhub_admin_save_platform_setting");
    expect(sql).toContain("grant execute on function public.powerhub_admin_save_platform_setting");
    expect(sql).toContain("to service_role");
  });
});

describe("platform settings Supabase adapter", () => {
  it("uses Supabase RPC and preserves omitted JSON values", () => {
    const source = read(adapterPath);
    expect(source).toContain('rpc("powerhub_admin_save_platform_setting"');
    expect(source).toContain("p_has_value: input.value !== undefined");
    expect(source).not.toContain("getDb(");
    expect(source).not.toContain("from \"./db\"");
    expect(source).not.toContain("drizzle");
  });
});

describe("platform settings runtime wiring", () => {
  it("overrides the legacy procedure and exposes it through appRouter", () => {
    const router = read(routerPath);
    const appRouter = read(appRouterPath);
    expect(router).toContain("savePlatformSetting: platformAdminSavePlatformSettingProcedure");
    expect(router).toContain("adminRouterWithSupabaseTariffPolicy");
    expect(appRouter).toContain('import { adminRouterWithSupabasePlatformSetting } from "./admin-platform-setting-router"');
    expect(appRouter).toContain("admin: adminRouterWithSupabasePlatformSetting");
  });
});
