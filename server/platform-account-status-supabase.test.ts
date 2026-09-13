import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/20260912132000_powerhub_admin_set_platform_account_status_rpc.sql"), "utf8");
const adapter = readFileSync(resolve(process.cwd(), "server/platform-account-status-supabase.ts"), "utf8");
const router = readFileSync(resolve(process.cwd(), "server/admin-platform-access-router.ts"), "utf8");
const appRouter = readFileSync(resolve(process.cwd(), "server/routers.ts"), "utf8");

describe("platform account status Supabase migration", () => {
  it("keeps the RPC atomic, audited, SECURITY DEFINER, and service-role-only", () => {
    expect(migration).toContain("create or replace function public.powerhub_admin_set_platform_account_status");
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = public, pg_temp");
    expect(migration).toContain("p_account_status not in ('active', 'locked', 'disabled')");
    expect(migration).toContain("SELF_STATUS_CHANGE");
    expect(migration).toContain("ACCOUNT_NOT_FOUND");
    expect(migration).toContain("PLATFORM_OWNER_PROTECTED");
    expect(migration).toContain("update public.users");
    expect(migration).toContain("insert into public.platform_security_events");
    expect(migration).toContain("revoke all on function public.powerhub_admin_set_platform_account_status");
    expect(migration).toContain("grant execute on function public.powerhub_admin_set_platform_account_status");
  });

  it("keeps the adapter free of Drizzle/MySQL and maps RPC errors", () => {
    expect(adapter).toContain("powerhub_admin_set_platform_account_status");
    expect(adapter).toContain("SELF_STATUS_CHANGE");
    expect(adapter).toContain("PLATFORM_OWNER_PROTECTED");
    expect(adapter).not.toContain("getDb");
    expect(adapter).not.toContain("drizzle");
    expect(adapter).not.toContain("mysql");
  });

  it("keeps the runtime route owner-only and preserves the public tRPC procedure name", () => {
    expect(router).toContain("adminRouterWithSupabasePlatformAccess");
    expect(router).toContain("setPlatformAccountStatus");
    expect(router).toContain("platform_owner");
    expect(router).toContain("accountStatus");
    expect(appRouter).toContain("adminRouterWithSupabasePlatformSetting");
    expect(appRouter).toContain("admin: adminRouterWithSupabasePlatformSetting");
  });
});
